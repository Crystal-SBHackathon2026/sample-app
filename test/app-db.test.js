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
      const base = await host(t, {store, env: {APP_CONTROL_FILE: file},
        logger: {warn() {}}});
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
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
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
      const info = await (await fetch(`${base}/api/info`)).json();
      assert.equal(info.writes_paused, true);
    });

/** Builds a store double that refuses paused writes like the real core. */
function pausableStore() {
  const {RequestStoreError} = require('@team-ghost/request-store');
  const record = {request_id: '21d10fd2-5b3c-4ab3-9c7f-c47ee6234e59'};
  return {
    writesPaused: false, inFlightWrites: 0, writes: 0,
    async pauseWrites() { this.writesPaused = true; },
    resumeWrites() { this.writesPaused = false; },
    async put() {
      if (this.writesPaused) {
        throw new RequestStoreError('WRITES_PAUSED', 'paused');
      }
      this.writes++;
      return {created: true, request: record, database: {name: 'db'}};
    },
    async get() { return {request: record, database: {name: 'db'}}; },
    async checkReady() { return {name: 'db'}; },
    async status() { return {name: 'db', row_count: '1'}; },
    async close() {},
  };
}

/**
 * Splits the one startup auth-mode warning from every other warning, so
 * control assertions still count any unexpected message.
 */
function splitWarnings(warnings) {
  const isAuth = (message) => message.startsWith('request API');
  return {
    auth: warnings.filter(isAuth),
    control: warnings.filter((message) => !isAuth(message)),
  };
}

test('invalid control keeps writes paused while reads and readiness serve',
    async (t) => {
      for (const content of ['{"writes_paused":"true"}', '{broken']) {
        const directory = await mkdtemp(join(tmpdir(), 'ghost-invalid-'));
        t.after(() => rm(directory, {recursive: true, force: true}));
        const file = join(directory, 'control.json');
        await writeFile(file, content);
        const store = pausableStore();
        const base = await host(t, {store, env: {APP_CONTROL_FILE: file},
          logger: {warn() {}}});
        const post = await fetch(`${base}/api/requests`, {method: 'POST',
          headers: {'content-type': 'application/json'}, body: '{}'});
        assert.equal(post.status, 503, content);
        assert.equal((await post.json()).error.code, 'WRITES_PAUSED');
        assert.equal(store.writes, 0);
        assert.equal((await fetch(`${base}/api/requests/id`)).status, 200);
        assert.equal((await fetch(`${base}/readyz`)).status, 200, content);
        const info = await fetch(`${base}/api/info`);
        assert.equal(info.status, 200, content);
        const body = await info.json();
        assert.deepEqual(body.write_control, {healthy: false});
        assert.equal(body.writes_paused, true);
      }
    });

test('a valid control file stays healthy when the store refuses to resume',
    async (t) => {
      const {RequestStoreError} = require('@team-ghost/request-store');
      const directory = await mkdtemp(join(tmpdir(), 'ghost-resume-'));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const file = join(directory, 'control.json');
      await writeFile(file, '{"writes_paused":false}');
      const store = pausableStore();
      store.writesPaused = true;
      // The core refuses resume while it replaces or closes its pool.
      store.resumeWrites = () => {
        throw new RequestStoreError('DB_UNAVAILABLE',
            'Database is unavailable');
      };
      const warnings = [];
      const base = await host(t, {store, env: {APP_CONTROL_FILE: file},
        logger: {warn: (message) => warnings.push(message)}});
      const post = await fetch(`${base}/api/requests`, {method: 'POST',
        headers: {'content-type': 'application/json'}, body: '{}'});
      assert.equal(post.status, 503);
      assert.equal((await post.json()).error.code, 'WRITES_PAUSED');
      assert.equal(store.writes, 0);
      const metrics = await (await fetch(`${base}/metrics`)).text();
      assert.match(metrics, /^app_write_control_healthy\{[^}]*\} 1$/m);
      assert.deepEqual(splitWarnings(warnings).control, []);
      assert.equal(splitWarnings(warnings).auth.length, 1);
      const info = await (await fetch(`${base}/api/info`)).json();
      assert.deepEqual(info.write_control, {healthy: true});
      assert.equal(info.writes_paused, true);
    });

test('readiness recovery restores the DB identity gauge cleared by an outage',
    async (t) => {
      const store = pausableStore();
      let outage = false;
      store.checkReady = async () => {
        if (outage) throw new Error('connection refused');
        return {name: 'db'};
      };
      const base = await host(t, {store});
      const identity = async () => {
        const text = await (await fetch(`${base}/metrics`)).text();
        return text.match(
            /^app_database_info\{[^}]*database="db"[^}]*\} (\d+)$/m)?.[1];
      };
      assert.equal((await fetch(`${base}/api/info`)).status, 200);
      assert.equal(await identity(), '1');
      outage = true;
      assert.equal((await fetch(`${base}/readyz`)).status, 503);
      assert.equal(await identity(), undefined);
      outage = false;
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
      assert.equal(await identity(), '1');
    });

test('control health transitions log once each and flip the gauge 0 to 1',
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'ghost-transition-'));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const file = join(directory, 'control.json');
      const warnings = [];
      const base = await host(t, {store: pausableStore(),
        env: {APP_CONTROL_FILE: file},
        logger: {warn: (message) => warnings.push(message)}});
      const gauge = async () => {
        const text = await (await fetch(`${base}/metrics`)).text();
        return text.match(/^app_write_control_healthy\{[^}]*\} (\d+)$/m)?.[1];
      };
      const control = () => splitWarnings(warnings).control;
      await writeFile(file, '{"writes_paused":false}');
      await fetch(`${base}/readyz`);
      assert.equal(await gauge(), '1');
      assert.equal(control().length, 0);
      await writeFile(file, '{broken');
      for (let i = 0; i < 3; i++) {
        await fetch(`${base}/readyz`);
      }
      assert.equal(await gauge(), '0');
      assert.equal(control().length, 1);
      assert.match(control()[0], /invalid/);
      await writeFile(file, '{"writes_paused":false}');
      for (let i = 0; i < 3; i++) {
        await fetch(`${base}/readyz`);
      }
      assert.equal(await gauge(), '1');
      assert.equal(control().length, 2);
      assert.match(control()[1], /recovered/);
      assert.equal(splitWarnings(warnings).auth.length, 1);
      assert.equal((await (await fetch(`${base}/api/info`)).json())
          .write_control.healthy, true);
    });
