const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createApp} = require('../src/app');

const FULL_ID = '21d10fd2-5b3c-4ab3-9c7f-c47ee6234e59';
const SNAPSHOT = {
  name: 'demo', row_count: '170675', recent: [{
    request_id: FULL_ID, run_id: 'forward_001', phase: 'onprem_live',
    created_at: '2026-11-06T00:00:00.000Z',
  }],
};

async function host(t, options) {
  const app = createApp({logger: {warn() {}}, ...options});
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/** Counts liveSnapshot calls; a test can replace `read` with its own. */
function countingStore(read = async () => SNAPSHOT) {
  return {
    writesPaused: false, inFlightWrites: 0, calls: 0, read,
    async liveSnapshot(limit) {
      this.calls++;
      this.limit = limit;
      return this.read();
    },
    async pauseWrites() { this.writesPaused = true; },
    resumeWrites() { this.writesPaused = false; },
    async status() { return {name: 'demo', row_count: '1'}; },
    async close() {},
  };
}

const live = (base) => fetch(`${base}/api/live`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('/api/live returns deployment, DB identity and the newest 20 rows',
    async (t) => {
      const store = countingStore();
      const base = await host(t, {store, info: {
        environment: 'aws', region: 'ap-northeast-2', version: 'abc',
      }});
      const response = await live(base);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.equal(store.limit, 20);
      assert.equal(typeof body.observed_at, 'string');
      delete body.observed_at;
      assert.deepEqual(body, {
        environment: 'aws', region: 'ap-northeast-2', version: 'abc',
        database: {name: 'demo', row_count: '170675'},
        recent: [{
          request_id_prefix: '21d10fd2', run_id: 'forward_001',
          phase: 'onprem_live', created_at: '2026-11-06T00:00:00.000Z',
        }],
        writes_paused: false,
      });
    });

test('/api/live never exposes a payload or a full request id', async (t) => {
  const row = {...SNAPSHOT.recent[0], payload: 'secret', request_no: '7'};
  const store = countingStore(async () => ({...SNAPSHOT, recent: [row]}));
  const text = await (await live(await host(t, {store}))).text();
  assert.doesNotMatch(text, /secret|request_no|payload/);
  assert.doesNotMatch(text, new RegExp(FULL_ID));
});

test('a DB outage answers 503 with minimal info and hides the cause',
    async (t) => {
      const store = countingStore(async () => {
        throw new Error('postgres://private:password@host');
      });
      store.writesPaused = true;
      const base = await host(t, {store, info: {environment: 'onprem'}});
      const response = await live(base);
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.doesNotMatch(text, /private|password|postgres:/);
      const body = JSON.parse(text);
      assert.equal(body.error.code, 'DB_UNAVAILABLE');
      assert.equal(body.environment, 'onprem');
      assert.equal(body.database, null);
      assert.deepEqual(body.recent, []);
      assert.equal(body.writes_paused, true);
    });

test('a host without a database answers the same 503', async (t) => {
  const response = await live(await host(t, {store: null}));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'DB_UNAVAILABLE');
  assert.equal(body.writes_paused, false);
});

test('concurrent viewers share one DB read', async (t) => {
  const store = countingStore(async () => {
    await sleep(20);
    return SNAPSHOT;
  });
  const base = await host(t, {store});
  const responses = await Promise.all(
      Array.from({length: 12}, () => live(base)));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(store.calls, 1);
});

test('the DB result is reused for one second, then read again', async (t) => {
  const store = countingStore();
  const base = await host(t, {store});
  const first = await (await live(base)).json();
  const second = await (await live(base)).json();
  assert.equal(store.calls, 1);
  assert.equal(second.observed_at, first.observed_at);
  await sleep(1100);
  await live(base);
  assert.equal(store.calls, 2);
});

test('an outage is cached too, so polling does not hammer the pool',
    async (t) => {
      const store = countingStore(async () => { throw new Error('down'); });
      const base = await host(t, {store});
      assert.equal((await live(base)).status, 503);
      assert.equal((await live(base)).status, 503);
      assert.equal(store.calls, 1);
    });

test('a hung DB answers 503 within two seconds and keeps one read in flight',
    async (t) => {
      let finish;
      const hung = new Promise((resolve) => { finish = resolve; });
      t.after(() => finish(SNAPSHOT));
      const store = countingStore(() => hung);
      const base = await host(t, {store});
      const started = Date.now();
      assert.equal((await live(base)).status, 503);
      assert.ok(Date.now() - started < 2500);
      await sleep(1100);
      assert.equal((await live(base)).status, 503);
      assert.equal(store.calls, 1);
    });

test('every poll one second apart gets a new read, however long it took',
    async (t) => {
      const store = countingStore(async () => {
        await sleep(50);
        return SNAPSHOT;
      });
      const base = await host(t, {store});
      await live(base);
      await sleep(1000 - 50);
      await live(base);
      assert.equal(store.calls, 2);
    });

test('a failed read clears, so the next read can recover', async (t) => {
  let down = true;
  const store = countingStore(async () => {
    if (down) throw new Error('down');
    return SNAPSHOT;
  });
  const base = await host(t, {store});
  assert.equal((await live(base)).status, 503);
  down = false;
  await sleep(1100);
  assert.equal((await live(base)).status, 200);
});

test('a read finishing after the wait still reaches the next poll',
    async (t) => {
      let finish;
      const slow = new Promise((resolve) => { finish = resolve; });
      const store = countingStore(() => slow);
      const base = await host(t, {store});
      assert.equal((await live(base)).status, 503);
      finish(SNAPSHOT);
      await sleep(10);
      assert.equal((await live(base)).status, 200);
      assert.equal(store.calls, 1);
    });

test('writes_paused is current even while the DB result is cached',
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'ghost-live-'));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const file = join(directory, 'control.json');
      await writeFile(file, '{"writes_paused":false}');
      const store = countingStore();
      const base = await host(t, {store, env: {APP_CONTROL_FILE: file}});
      assert.equal((await (await live(base)).json()).writes_paused, false);
      await writeFile(file, '{"writes_paused":true}');
      assert.equal((await (await live(base)).json()).writes_paused, true);
      assert.equal(store.calls, 1);
    });

test('pause drain does not hold the dashboard behind an active write',
    async (t) => {
      let finish;
      const draining = new Promise((resolve) => { finish = resolve; });
      t.after(() => finish());
      const store = countingStore();
      store.pauseWrites = async function() {
        this.writesPaused = true;
        await draining;
      };
      const base = await host(t, {store, env: {WRITES_PAUSED: 'true'}});
      const response = await fetch(`${base}/api/live`, {
        signal: AbortSignal.timeout(500),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).writes_paused, true);
    });

test('/api/live stays open whatever the request API auth mode is',
    async (t) => {
      const token = 'test-token-'.padEnd(40, 'a');
      for (const env of [
        {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token},
        {REQUEST_API_AUTH: 'required'},
      ]) {
        const base = await host(t, {store: countingStore(), env});
        assert.notEqual((await fetch(`${base}/api/requests/x`)).status, 200);
        assert.equal((await live(base)).status, 200);
      }
    });

test('dashboard polling stays out of the canary HTTP error-rate series',
    async (t) => {
      const store = countingStore(async () => { throw new Error('down'); });
      const base = await host(t, {store});
      assert.equal((await live(base)).status, 503);
      const metrics = await (await fetch(`${base}/metrics`)).text();
      assert.doesNotMatch(metrics, /^http_[a-z_]+\{[^}]*\/api\/live/m);
    });

test('/api/info keeps its exact field set', async (t) => {
  const store = countingStore();
  const info = await (await fetch(`${await host(t, {store})}/api/info`)).json();
  assert.deepEqual(Object.keys(info).sort(), [
    'app', 'database', 'environment', 'region', 'startedAt', 'version',
    'write_control', 'writes_in_flight', 'writes_paused',
  ]);
});
