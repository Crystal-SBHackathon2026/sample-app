const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createApp} = require('../src/app');

async function host(t, options) {
  const app = createApp(options);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('DB outage fails readiness while liveness and safe diagnostics survive',
    async (t) => {
      const store = {
        writesPaused: false,
        async status() { throw new Error('postgres://private:password@host'); },
        async close() {},
      };
      const base = await host(t, {store});
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      assert.equal((await fetch(`${base}/readyz`)).status, 503);
      const response = await fetch(`${base}/api/info`);
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /private|password|postgres:/);
      const page = await (await fetch(`${base}/`)).text();
      assert.match(page, /Ghost Migration Demo/);
      assert.doesNotMatch(page, /password/);
    });

test('file control pauses writes, keeps reads, fails closed then recovers',
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'ghost-control-'));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const file = join(directory, 'control.json');
      let writeCount = 0;
      const record = {request_id: '21d10fd2-5b3c-4ab3-9c7f-c47ee6234e59'};
      const store = {
        writesPaused: false,
        async status() { return {name: 'test-db', row_count: '1'}; },
        async pauseWrites() { this.writesPaused = true; },
        resumeWrites() { this.writesPaused = false; },
        async put() {
          if (this.writesPaused) {
            const {RequestStoreError} = require('@team-ghost/request-store');
            throw new RequestStoreError('WRITES_PAUSED', 'paused');
          }
          writeCount++;
          return {created: true, request: record, database: {name: 'test-db'}};
        },
        async get() { return {request: record, database: {name: 'test-db'}}; },
        async close() {},
      };
      await writeFile(file, '{"writes_paused":true}');
      const base = await host(t, {store, env: {APP_CONTROL_FILE: file}});
      const post = () => fetch(`${base}/api/requests`, {method: 'POST',
        headers: {'content-type': 'application/json'}, body: '{}'});
      const paused = await post();
      assert.equal(paused.status, 503);
      assert.equal(paused.headers.get('retry-after'), '1');
      assert.equal(writeCount, 0);
      assert.equal((await fetch(
          `${base}/api/requests/${record.request_id}`)).status, 200);
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
      await writeFile(file, '{broken');
      assert.equal((await fetch(`${base}/readyz`)).status, 503);
      assert.equal((await post()).status, 503);
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      await writeFile(file, '{"writes_paused":false}');
      assert.equal((await post()).status, 201);
      assert.equal(writeCount, 1);
      const body = await (await fetch(`${base}/api/info`)).json();
      assert.equal(body.database.name, 'test-db');
      assert.equal(body.writes_paused, false);
    });

test('HTML escapes deployment metadata and DB identity', async (t) => {
  const base = await host(t, {store: {
    async status() { return {name: '<script>bad()</script>', row_count: '0'}; },
    async close() {},
  }, info: {environment: '<img src=x onerror=bad()>'}});
  const page = await (await fetch(base)).text();
  assert.doesNotMatch(page, /<script>|<img/);
  assert.match(page, /&lt;script&gt;/);
});

test('pause drain does not hold reads or readiness behind an active write',
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'ghost-drain-'));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const file = join(directory, 'control.json');
      await writeFile(file, '{"writes_paused":true}');
      let finish;
      const draining = new Promise((resolve) => { finish = resolve; });
      t.after(() => finish());
      const store = {
        writesPaused: false, inFlightWrites: 1,
        async pauseWrites() { this.writesPaused = true; await draining; },
        resumeWrites() { this.writesPaused = false; },
        async checkReady() {},
        async status() { return {name: 'db', row_count: '1'}; },
        async get() { return {request: {}, database: {name: 'db'}}; },
        async close() { finish(); },
      };
      const base = await host(t, {store, env: {APP_CONTROL_FILE: file}});
      const response = await fetch(`${base}/api/requests/id`, {
        signal: AbortSignal.timeout(500),
      });
      assert.equal(response.status, 200);
      assert.equal((await fetch(`${base}/readyz`, {
        signal: AbortSignal.timeout(500),
      })).status, 200);
      const info = await (await fetch(`${base}/api/info`)).json();
      assert.equal(info.writes_paused, true);
      assert.equal(info.writes_in_flight, 1);
      finish();
    });

test('concurrent diagnostic requests share one bounded count query',
    async (t) => {
      let count = 0;
      const base = await host(t, {store: {
        async status() {
          count++;
          await new Promise((resolve) => setImmediate(resolve));
          return {name: 'db', row_count: '1'};
        },
        async checkReady() {},
        async close() {},
      }});
      const responses = await Promise.all(Array.from({length: 12}, () =>
        fetch(`${base}/api/info`)));
      assert.ok(responses.every((response) => response.status === 200));
      assert.equal(count, 1);
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
      assert.equal(count, 1);
    });

test('startup WRITES_PAUSED hold overrides a file that allows writes',
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'ghost-env-hold-'));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const file = join(directory, 'control.json');
      await writeFile(file, '{"writes_paused":false}');
      const store = {
        writesPaused: false,
        async pauseWrites() { this.writesPaused = true; },
        resumeWrites() { this.writesPaused = false; },
        async checkReady() {},
        async status() { return {name: 'db', row_count: '0'}; },
        async close() {},
      };
      const base = await host(t, {store, env: {
        WRITES_PAUSED: 'true', APP_CONTROL_FILE: file,
      }});
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
      assert.equal((await (await fetch(`${base}/api/info`)).json()).writes_paused,
          true);
    });
