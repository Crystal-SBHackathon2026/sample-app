const {test} = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRequest, postgresOptionsFromEnv, createPostgresRequestStore,
} = require('../packages/request-store');

const record = {
  request_id: '21D10FD2-5B3C-4AB3-9C7F-C47EE6234E59',
  run_id: 'forward_001', phase: 'onprem_live', request_no: '0001',
  payload: 'payload', created_at: '2026-11-04T09:00:00+09:00',
};

test('request normalization preserves bigint and normalizes UUID/timezone', () => {
  assert.deepEqual(normalizeRequest(record), {
    ...record, request_id: record.request_id.toLowerCase(), request_no: '1',
    created_at: '2026-11-04T00:00:00.000Z',
  });
  assert.equal(normalizeRequest({...record,
    request_no: '9223372036854775807'}).request_no, '9223372036854775807');
});

test('invalid, ambiguous or silently lossy request values are rejected', () => {
  for (const patch of [
    {request_id: 'not-a-uuid'}, {request_no: 9007199254740992},
    {request_no: '9223372036854775808'}, {payload: {}},
    {created_at: '2026-02-30T00:00:00Z'},
    {created_at: '2026-11-04T00:00:00'},
    {created_at: '2026-11-04T00:00:00.123456Z'}, {extra: 'ignored?'},
  ]) {
    assert.throws(() => normalizeRequest({...record, ...patch}),
        {code: 'INVALID_REQUEST'});
  }
});

test('TLS URLs cannot silently override certificate verification', () => {
  const options = postgresOptionsFromEnv({
    DATABASE_URL: 'postgres://user:pass@db/demo?sslmode=require',
  });
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(new URL(options.connectionString).searchParams.has('sslmode'),
      false);
  assert.throws(() => postgresOptionsFromEnv({
    DATABASE_URL: 'postgres://user:pass@db/demo?sslmode=no-verify',
  }), {code: 'INVALID_CONFIGURATION'});
});

test('pause drains accepted writes and rejects subsequent ones', async () => {
  let allowInsert;
  const inserted = new Promise((resolve) => { allowInsert = resolve; });
  let inserting;
  const entered = new Promise((resolve) => { inserting = resolve; });
  const row = normalizeRequest(record);
  const client = {
    async query(sql) {
      if (sql.startsWith('INSERT')) {
        inserting();
        await inserted;
        return {rowCount: 1, rows: [row]};
      }
      if (sql.startsWith('SELECT current_database')) {
        return {rows: [{name: 'demo'}]};
      }
      return {rows: []};
    },
    release() {},
  };
  const store = createPostgresRequestStore({
    poolFactory: () => ({on() {}, connect: async () => client, end: async () => {}}),
  });
  const write = store.put(record);
  await entered;
  assert.equal(store.inFlightWrites, 1);
  let drained = false;
  const pause = store.pauseWrites().then(() => { drained = true; });
  await assert.rejects(store.put(record), {code: 'WRITES_PAUSED'});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  allowInsert();
  assert.equal((await write).created, true);
  await pause;
  assert.equal(drained, true);
  assert.equal(store.inFlightWrites, 0);
  assert.equal(store.writesPaused, true);
  await store.close();
});

test('replacement blocks resume and concurrent replacement until old pool closes',
    async () => {
      let releaseOld;
      let oldClosing;
      const closing = new Promise((resolve) => { oldClosing = resolve; });
      const ended = new Promise((resolve) => { releaseOld = resolve; });
      let calls = 0;
      const store = createPostgresRequestStore({poolFactory: () => {
        calls++;
        if (calls === 1) {
          return {on() {}, async end() { oldClosing(); await ended; }};
        }
        return {on() {}, query: async () => ({rows: []}),
          end: async () => {}};
      }});
      await store.pauseWrites();
      const replace = store.replaceConnection({});
      await closing;
      assert.throws(() => store.resumeWrites(), {code: 'DB_UNAVAILABLE'});
      await assert.rejects(store.replaceConnection({}),
          {code: 'DB_UNAVAILABLE'});
      await assert.rejects(store.put(record), {code: 'DB_UNAVAILABLE'});
      releaseOld();
      await replace;
      assert.equal(store.writesPaused, true);
      store.resumeWrites();
      assert.equal(store.writesPaused, false);
      await store.close();
    });

test('direct core connection options cannot disable certificate verification',
    () => {
      assert.throws(() => createPostgresRequestStore({
        connectionString: 'postgres://user:pass@db/demo?sslmode=require',
      }), {code: 'INVALID_CONFIGURATION'});
      assert.throws(() => createPostgresRequestStore({
        connectionString: 'postgres://user:pass@db/demo',
        ssl: {rejectUnauthorized: false},
      }), {code: 'INVALID_CONFIGURATION'});
    });


test('payload cap counts UTF-8 bytes and includes multibyte boundaries', () => {
  assert.equal(normalizeRequest({...record,
    payload: 'a'.repeat(65536)}).payload.length, 65536);
  assert.throws(() => normalizeRequest({...record,
    payload: 'a'.repeat(65537)}), {code: 'INVALID_REQUEST'});
  assert.throws(() => normalizeRequest({...record,
    payload: '가'.repeat(21846)}), {code: 'INVALID_REQUEST'});
});

test('close waits for an active replacement and closes the surviving pool',
    async () => {
      let allowCandidate;
      const ready = new Promise((resolve) => { allowCandidate = resolve; });
      let candidateEntered;
      const entered = new Promise((resolve) => { candidateEntered = resolve; });
      let calls = 0;
      let oldClosed = 0;
      let newClosed = 0;
      const store = createPostgresRequestStore({poolFactory: () => {
        if (++calls === 1) {
          return {on() {}, async end() { oldClosed++; }};
        }
        return {on() {}, async query() { candidateEntered(); await ready; },
          async end() { newClosed++; }};
      }});
      await store.pauseWrites();
      const replacement = store.replaceConnection({});
      await entered;
      const closing = store.close();
      assert.equal(closing, store.close());
      assert.throws(() => store.resumeWrites(), {code: 'DB_UNAVAILABLE'});
      allowCandidate();
      await replacement;
      await closing;
      assert.equal(oldClosed, 1);
      assert.equal(newClosed, 1);
    });

test('driver failures discard connections; rolled-back conflicts reuse them',
    async () => {
      const driverError = new Error('query read timeout');
      for (const mode of ['driver', 'conflict', 'rollback-failed']) {
        const released = [];
        let poolConfig;
        const client = {
          async query(sql) {
            if (sql.startsWith('INSERT')) {
              if (mode === 'driver') throw driverError;
              return {rows: [], rowCount: 0};
            }
            if (sql === 'ROLLBACK' && mode === 'rollback-failed') {
              throw driverError;
            }
            return {rows: []};
          },
          release(error) { released.push(error); },
        };
        const store = createPostgresRequestStore({poolFactory: (config) => {
          poolConfig = config;
          return {on() {}, connect: async () => client, end: async () => {}};
        }});
        await assert.rejects(store.put(record), {
          code: mode === 'conflict' ? 'REQUEST_CONFLICT' : 'DB_UNAVAILABLE',
        });
        assert.equal(poolConfig.keepAlive, true);
        assert.equal(released.length, 1);
        assert.equal(released[0], mode === 'conflict' ? undefined : driverError);
        await store.close();
      }
    });

test('TLS requirement cannot be downgraded and inline CA has a file fallback',
    () => {
      const url = 'postgres://user:pass@db/demo?sslmode=disable';
      assert.throws(() => postgresOptionsFromEnv({
        DATABASE_URL: url, DB_SSL: 'true',
      }), {code: 'INVALID_CONFIGURATION'});
      assert.throws(() => postgresOptionsFromEnv({
        DATABASE_URL: url, DB_SSL_CA: 'PEM from secret',
      }), {code: 'INVALID_CONFIGURATION'});
      const config = postgresOptionsFromEnv({
        DATABASE_URL: url, DB_SSL: 'true', PGSSLMODE: 'verify-full',
        DB_SSL_CA: 'PEM from secret',
      });
      assert.equal(config.ssl.ca, 'PEM from secret');
      assert.equal(config.ssl.rejectUnauthorized, true);
      const fileConfig = postgresOptionsFromEnv({
        DATABASE_URL: url, DB_SSL: 'true', PGSSLMODE: 'verify-full',
        DB_SSL_CA: 'must not win', PGSSLROOTCERT: __filename,
      });
      assert.match(fileConfig.ssl.ca, /driver failures discard connections/);
    });

test('readiness checks schema access without scanning or counting rows',
    async () => {
      const queries = [];
      const store = createPostgresRequestStore({poolFactory: () => ({
        on() {}, end: async () => {},
        connect: async () => ({
          async query(sql) {
            queries.push(sql);
            return {rows: [{name: 'ready-db'}]};
          },
          release() {},
        }),
      })});
      assert.deepEqual(await store.checkReady(), {name: 'ready-db'});
      assert.match(queries[0], /FROM public\.migration_demo LIMIT 0/);
      assert.match(queries[1], /current_database/);
      assert.equal(queries.some((sql) => /count\s*\(/i.test(sql)), false);
      assert.equal(store.inFlightWrites, 0);
      await store.close();
    });

test('unsupported JSON charsets return the documented 400 error envelope',
    async (t) => {
      const express = require('express');
      const {createRequestRouter} = require('../packages/request-store/express');
      const app = express();
      app.use('/requests', createRequestRouter({store: null}));
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const response = await fetch(
          `http://127.0.0.1:${server.address().port}/requests`, {
            method: 'POST',
            headers: {'content-type': 'application/json; charset=iso-8859-1'},
            body: '{}',
          });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {error: {
        code: 'INVALID_REQUEST', message: 'Invalid JSON request body',
      }});
    });
