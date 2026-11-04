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

test('request normalization preserves bigint and normalizes UUID/timezone',
    () => {
      assert.deepEqual(normalizeRequest(record), {
        ...record, request_id: record.request_id.toLowerCase(),
        request_no: '1', created_at: '2026-11-04T00:00:00.000Z',
      });
      const max = '9223372036854775807';
      assert.equal(normalizeRequest({...record, request_no: max}).request_no,
          max);
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

test('lone surrogates are rejected because PostgreSQL would replace them',
    () => {
      for (const field of ['run_id', 'phase', 'payload']) {
        for (const text of ['\ud800', 'a\udc00', '\udc00\ud800']) {
          assert.throws(() => normalizeRequest({...record, [field]: text}),
              {code: 'INVALID_REQUEST'}, `${field} ${JSON.stringify(text)}`);
        }
      }
    });

test('astral Unicode characters are stored unchanged', () => {
  const astral = 'run \u{1f47b}';  // 'run 👻'
  const normalized = normalizeRequest({...record,
    run_id: astral, phase: astral, payload: astral});
  assert.equal(normalized.run_id, astral);
  assert.equal(normalized.phase, astral);
  assert.equal(normalized.payload, astral);
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
    poolFactory: () => ({
      on() {}, connect: async () => client, end: async () => {},
    }),
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

/** Builds a pool double whose clients answer reads from the given DB name. */
function readablePool(name, overrides = {}) {
  const row = normalizeRequest(record);
  return {
    on() {},
    query: async () => ({rows: []}),
    connect: async () => ({
      async query(sql) {
        if (sql.startsWith('SELECT current_database')) {
          return {rows: [{name}]};
        }
        return {rows: [row]};
      },
      release() {},
    }),
    end: async () => {},
    ...overrides,
  };
}

test('old pool end failure keeps the validated candidate pool in service',
    async () => {
      const observations = [];
      let candidateEnded = 0;
      let calls = 0;
      const store = createPostgresRequestStore({
        onObservation: (event) => observations.push(event),
        poolFactory: () => {
          if (++calls === 1) {
            return readablePool('old', {
              end: async () => { throw new Error('old pool end failed'); },
            });
          }
          return readablePool('candidate', {
            end: async () => { candidateEnded++; },
          });
        },
      });
      await store.pauseWrites();
      await store.replaceConnection({});
      assert.equal(candidateEnded, 0);
      assert.equal((await store.get(record.request_id)).database.name,
          'candidate');
      assert.ok(observations.some((event) =>
        event.operation === 'connection' && event.outcome === 'error'));
      store.resumeWrites();
      assert.equal(store.writesPaused, false);
      await store.close();
      assert.equal(candidateEnded, 1);
    });

test('reads and readiness use the candidate while the old pool closes',
    async () => {
      let releaseOld;
      const oldEnded = new Promise((resolve) => { releaseOld = resolve; });
      let oldClosing;
      const closing = new Promise((resolve) => { oldClosing = resolve; });
      let calls = 0;
      const store = createPostgresRequestStore({poolFactory: () => {
        if (++calls === 1) {
          return readablePool('old', {
            async end() { oldClosing(); await oldEnded; },
          });
        }
        return readablePool('candidate');
      }});
      await store.pauseWrites();
      const replacement = store.replaceConnection({});
      await closing;
      assert.equal((await store.get(record.request_id)).database.name,
          'candidate');
      assert.deepEqual(await store.checkReady(), {name: 'candidate'});
      assert.throws(() => store.resumeWrites(), {code: 'DB_UNAVAILABLE'});
      await assert.rejects(store.replaceConnection({}),
          {code: 'DB_UNAVAILABLE'});
      await assert.rejects(store.put(record), {code: 'DB_UNAVAILABLE'});
      releaseOld();
      await replacement;
      await store.close();
    });

test('close during old pool cleanup ends the candidate after cleanup',
    async () => {
      let releaseOld;
      const oldEnded = new Promise((resolve) => { releaseOld = resolve; });
      let oldClosing;
      const closing = new Promise((resolve) => { oldClosing = resolve; });
      const order = [];
      let calls = 0;
      const store = createPostgresRequestStore({poolFactory: () => {
        if (++calls === 1) {
          return readablePool('old', {async end() {
            oldClosing();
            await oldEnded;
            order.push('old');
          }});
        }
        return readablePool('candidate', {
          async end() { order.push('candidate'); },
        });
      }});
      await store.pauseWrites();
      const replacement = store.replaceConnection({});
      await closing;
      const closed = store.close();
      await assert.rejects(store.get(record.request_id),
          {code: 'DB_UNAVAILABLE'});
      releaseOld();
      await replacement;
      await closed;
      assert.deepEqual(order, ['old', 'candidate']);
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

/** Runs action with PGSSLMODE and pg.defaults.ssl set, then restores them. */
function withDriverTlsDefaults({mode, ssl}, action) {
  const {defaults} = require('pg');
  const saved = {mode: process.env.PGSSLMODE, ssl: defaults.ssl};
  if (mode === undefined) {
    delete process.env.PGSSLMODE;
  } else {
    process.env.PGSSLMODE = mode;
  }
  defaults.ssl = ssl;
  try {
    return action();
  } finally {
    if (saved.mode === undefined) {
      delete process.env.PGSSLMODE;
    } else {
      process.env.PGSSLMODE = saved.mode;
    }
    defaults.ssl = saved.ssl;
  }
}

test('direct core rejects every TLS input the driver would leave unverified',
    () => {
      const url = 'postgres://user:pass@db/demo';
      const inputs = [
        'no-verify', 'true', 'require', '', null, 0, 1, [],
        {rejectUnauthorized: false}, {rejectUnauthorized: 0},
        {rejectUnauthorized: undefined}, {rejectUnauthorized: 'false'},
        {checkServerIdentity: () => undefined},
      ];
      for (const ssl of inputs) {
        let pools = 0;
        assert.throws(() => createPostgresRequestStore({
          connectionString: url, ssl,
          poolFactory: () => { pools++; },
        }), {code: 'INVALID_CONFIGURATION'}, String(JSON.stringify(ssl)));
        assert.equal(pools, 0);
      }
    });

test('omitted ssl rejects driver defaults that disable verification', () => {
  for (const defaultsInput of [
    {mode: 'no-verify', ssl: false}, {mode: undefined, ssl: 'no-verify'},
    {mode: undefined, ssl: {rejectUnauthorized: false}},
  ]) {
    withDriverTlsDefaults(defaultsInput, () => {
      assert.throws(() => createPostgresRequestStore({
        connectionString: 'postgres://user:pass@db/demo',
        poolFactory: () => assert.fail('pool must not be created'),
      }), {code: 'INVALID_CONFIGURATION'}, JSON.stringify(defaultsInput));
    });
  }
});

test('accepted TLS inputs always reach pg.Client with verification on', () => {
  const {Client} = require('pg');
  const cases = [
    [{mode: undefined, ssl: false}, true, true],
    [{mode: undefined, ssl: false}, false, false],
    [{mode: undefined, ssl: false}, undefined, false],
    [{mode: 'require', ssl: false}, undefined, true],
    [{mode: undefined, ssl: false}, {ca: 'PEM'}, {ca: 'PEM'}],
    [{mode: undefined, ssl: false}, {rejectUnauthorized: true, ca: 'PEM'},
      {rejectUnauthorized: true, ca: 'PEM'}],
  ];
  for (const [defaultsInput, ssl, expected] of cases) {
    withDriverTlsDefaults(defaultsInput, () => {
      let config;
      const store = createPostgresRequestStore({
        connectionString: 'postgres://user:pass@db/demo', ssl,
        poolFactory: (poolConfig) => {
          config = poolConfig;
          return {on() {}, end: async () => {}};
        },
      });
      // Resolve TLS exactly as the driver will, without opening a socket.
      const finalSsl = new Client(config).connectionParameters.ssl;
      assert.deepEqual(finalSsl, expected, JSON.stringify(ssl));
      assert.notEqual(finalSsl?.rejectUnauthorized, false);
      return store.close();
    });
  }
});

test('invalid connection strings fail without echoing the secret', () => {
  const {inspect} = require('node:util');
  for (const connectionString of [
    'host=db user=app password=dsn-secret-1', 'postgres://app:dsn-secret-1@[',
  ]) {
    let error;
    try {
      createPostgresRequestStore({connectionString,
        poolFactory: () => assert.fail('pool must not be created')});
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, 'INVALID_CONFIGURATION');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(inspect(error, {showHidden: true, depth: 5}),
        /dsn-secret-1/);
    assert.doesNotMatch(JSON.stringify(error), /dsn-secret-1/);
  }
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
        assert.equal(released[0],
            mode === 'conflict' ? undefined : driverError);
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
      const {createRequestRouter} =
          require('../packages/request-store/express');
      const app = express();
      app.use('/requests', createRequestRouter({store: null,
        getContext: () => ({environment: 'test'})}));
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

test('request router requires a getContext function at creation', () => {
  const {createRequestRouter} = require('../packages/request-store/express');
  assert.throws(() => createRequestRouter({store: null}), TypeError);
  assert.throws(() => createRequestRouter({store: null, getContext: {}}),
      TypeError);
});

test('invalid response context returns 500 before the store is touched',
    async (t) => {
      const express = require('express');
      const {createRequestRouter} =
          require('../packages/request-store/express');
      let storeCalls = 0;
      const store = {
        async put() { storeCalls++; throw new Error('must not write'); },
        async get() { storeCalls++; throw new Error('must not read'); },
      };
      const app = express();
      for (const [path, context] of [
        ['/empty', {environment: ''}], ['/missing', {region: 'local'}],
        ['/number', {environment: 1}], ['/none', undefined],
      ]) {
        app.use(path, createRequestRouter({store, getContext: () => context}));
      }
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const path of ['/empty', '/missing', '/number', '/none']) {
        for (const response of [
          await fetch(`${base}${path}`, {method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(record)}),
          await fetch(`${base}${path}/${record.request_id}`),
        ]) {
          assert.equal(response.status, 500);
          assert.equal((await response.json()).error.code, 'CONTEXT_INVALID');
        }
      }
      assert.equal(storeCalls, 0);
    });
