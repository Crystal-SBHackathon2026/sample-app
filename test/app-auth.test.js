const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {mkdtemp, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {inspect} = require('node:util');
const {Pool} = require('pg');
const {createApp} = require('../src/app');

const CHALLENGE = 'Bearer realm="request-api"';
const INVALID_TOKEN_CHALLENGE =
    'Bearer realm="request-api", error="invalid_token"';
const RECORD_ID = '21d10fd2-5b3c-4ab3-9c7f-c47ee6234e59';

/** Returns a unique dummy token; never a real team value. */
function newToken() {
  return `test-token-${randomUUID()}`;
}

/** Serves createApp(options) on loopback and closes it after the test. */
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

/** Collects every log call so tests can search for leaked secrets. */
function recordingLogger() {
  const lines = [];
  const record = (level) => (...args) => {
    lines.push(`${level}: ${args.map((arg) => inspect(arg)).join(' ')}`);
  };
  return {
    lines,
    logger: {
      warn: record('warn'), info: record('info'), error: record('error'),
      log: record('log'), debug: record('debug'),
    },
  };
}

/** Builds a store double that counts every call the host could make. */
function countingStore() {
  const {RequestStoreError} = require('@team-ghost/request-store');
  const calls = {put: 0, get: 0, status: 0, checkReady: 0};
  return {
    calls, writesPaused: false, inFlightWrites: 0,
    async pauseWrites() { this.writesPaused = true; },
    resumeWrites() { this.writesPaused = false; },
    async put() {
      calls.put++;
      if (this.writesPaused) {
        throw new RequestStoreError('WRITES_PAUSED', 'paused');
      }
      return {created: true, request: {request_id: RECORD_ID},
        database: {name: 'db'}};
    },
    async get() {
      calls.get++;
      return {request: {request_id: RECORD_ID}, database: {name: 'db'}};
    },
    async checkReady() {
      calls.checkReady++;
      return {name: 'db'};
    },
    async status() {
      calls.status++;
      return {name: 'db', row_count: '1'};
    },
    async close() {},
  };
}

/** Sends a JSON POST to the request API with optional extra headers. */
function postRequest(base, headers = {}, body = '{}') {
  return fetch(`${base}/api/requests`, {method: 'POST',
    headers: {'content-type': 'application/json', ...headers}, body});
}

/** Reads one labeled sample from the app's /metrics text. */
async function metricSample(base, name, label) {
  const text = await (await fetch(`${base}/metrics`)).text();
  const pattern = new RegExp(`^${name}\\{[^}]*${label}[^}]*\\} (\\d+)$`, 'm');
  return text.match(pattern)?.[1];
}

/** Returns the current auth mode gauge values keyed by mode. */
async function modeGauge(base) {
  const modes = {};
  for (const mode of ['open', 'enforced', 'closed']) {
    modes[mode] = await metricSample(base, 'app_request_api_auth_mode',
        `mode="${mode}"`);
  }
  return modes;
}

test('S1 anonymous broken JSON is 401 before control file and store',
    async (t) => {
      const store = countingStore();
      const {lines, logger} = recordingLogger();
      const missing = join(tmpdir(), `ghost-missing-${randomUUID()}.json`);
      const base = await host(t, {store, logger, env: {
        REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: newToken(),
        APP_CONTROL_FILE: missing,
      }});
      const response = await postRequest(base, {}, '{broken');
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), CHALLENGE);
      assert.deepEqual(await response.json(), {error: {
        code: 'UNAUTHORIZED', message: 'Missing or invalid API token',
      }});
      assert.deepEqual(store.calls,
          {put: 0, get: 0, status: 0, checkReady: 0});
      assert.deepEqual(lines, []);
      assert.equal(await metricSample(base, 'app_write_control_healthy', ''),
          '1');
    });

test('S2 wrong or malformed Bearer tokens get invalid_token 401',
    async (t) => {
      const token = newToken();
      const store = countingStore();
      const base = await host(t, {store, logger: recordingLogger().logger,
        env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token}});
      const wrongSameLength = newToken();
      assert.equal(wrongSameLength.length, token.length);
      for (const authorization of [
        `Bearer ${wrongSameLength}`, `Bearer ${token}x`, 'Bearer',
        `Bearer ${token.slice(0, 20)} ${token.slice(20)}`, `Bearer ${token}!`,
      ]) {
        const response = await postRequest(base, {authorization});
        assert.equal(response.status, 401, authorization);
        assert.equal(response.headers.get('www-authenticate'),
            INVALID_TOKEN_CHALLENGE, authorization);
        assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
      }
      assert.equal(store.calls.put, 0);
    });

test('S2b other schemes get a challenge without an error code',
    async (t) => {
      const token = newToken();
      const store = countingStore();
      const base = await host(t, {store, logger: recordingLogger().logger,
        env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token}});
      for (const authorization of [`Basic ${token}`, `Bearer${token}`]) {
        const response = await postRequest(base, {authorization});
        assert.equal(response.status, 401, authorization);
        assert.equal(response.headers.get('www-authenticate'), CHALLENGE);
      }
      assert.equal(store.calls.put, 0);
    });

test('S2c scheme is case-insensitive and allows several spaces',
    async (t) => {
      const token = newToken();
      const store = countingStore();
      const base = await host(t, {store, logger: recordingLogger().logger,
        env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token}});
      for (const authorization of [
        `bearer ${token}`, `BEARER ${token}`, `Bearer   ${token}`,
      ]) {
        const response = await postRequest(base, {authorization});
        assert.equal(response.status, 201, authorization);
      }
      assert.equal(store.calls.put, 3);
    });

test('S3 real PostgreSQL rejects anonymous forward_001 and commits with token',
    {skip: !process.env.TEST_DATABASE_URL}, async (t) => {
      // Only TEST_DATABASE_URL is used; rows this test creates are removed.
      const {createPostgresRequestStore} =
          require('@team-ghost/request-store');
      const connectionString = process.env.TEST_DATABASE_URL;
      const admin = new Pool({connectionString});
      const token = newToken();
      const anonymousId = randomUUID();
      const authorizedId = randomUUID();
      t.after(async () => {
        await admin.query(
            'DELETE FROM public.migration_demo WHERE request_id = ANY($1)',
            [[anonymousId, authorizedId]]);
        await admin.end();
      });
      const base = await host(t, {
        store: createPostgresRequestStore({connectionString}),
        logger: recordingLogger().logger,
        env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token},
      });
      // Counts only this test's IDs, so parallel files may write forward_001.
      const rows = async (requestId) => (await admin.query(
          `SELECT count(*)::text AS n FROM public.migration_demo
          WHERE request_id = $1`, [requestId])).rows[0].n;
      const body = (requestId, runId) => JSON.stringify({
        request_id: requestId, run_id: runId, phase: 'aws_live',
        request_no: '1', payload: 'auth probe',
        created_at: '2026-11-04T00:00:00.000Z',
      });
      const anonymous = await postRequest(base, {},
          body(anonymousId, 'forward_001'));
      assert.equal(anonymous.status, 401);
      assert.equal(await rows(anonymousId), '0');
      const authorized = await postRequest(base,
          {authorization: `Bearer ${token}`},
          body(authorizedId, `auth-s3-${randomUUID()}`));
      assert.equal(authorized.status, 201);
      assert.equal(await rows(authorizedId), '1');
    });

test('S4 anonymous GET by id is 401 without a store read', async (t) => {
  const store = countingStore();
  const base = await host(t, {store, logger: recordingLogger().logger,
    env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: newToken()}});
  const response = await fetch(`${base}/api/requests/${RECORD_ID}`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), CHALLENGE);
  assert.equal(store.calls.get, 0);
});

test('S5 required without a token closes the API but keeps diagnostics',
    async (t) => {
      const store = countingStore();
      const base = await host(t, {store, logger: recordingLogger().logger,
        env: {REQUEST_API_AUTH: 'required'}});
      for (const response of [
        await postRequest(base),
        await fetch(`${base}/api/requests/${RECORD_ID}`),
      ]) {
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('www-authenticate'), null);
        assert.equal(response.headers.get('retry-after'), null);
        assert.deepEqual(await response.json(), {error: {
          code: 'API_AUTH_UNCONFIGURED',
          message: 'Request API authentication is not configured',
        }});
      }
      assert.equal(store.calls.put, 0);
      assert.equal(store.calls.get, 0);
      for (const path of ['/', '/healthz', '/readyz', '/api/info']) {
        assert.equal((await fetch(`${base}${path}`)).status, 200, path);
      }
    });

test('S6 invalid auth settings are closed, never open', async (t) => {
  const short = 'test-token-'.padEnd(31, 'a');
  const cases = [
    {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: short},
    {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: `${newToken()}!`},
    {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: ''},
    {REQUEST_API_AUTH: 'optional', REQUEST_API_TOKEN: ''},
    {REQUEST_API_TOKEN: ''},
    {REQUEST_API_TOKEN: short},
    {REQUEST_API_TOKEN: `${newToken()}!`},
    {REQUEST_API_AUTH: 'optional', REQUEST_API_TOKEN: short},
    {REQUEST_API_AUTH: 'optional', REQUEST_API_TOKEN: `${newToken()}!`},
    {REQUEST_API_AUTH: '', REQUEST_API_TOKEN: newToken()},
    {REQUEST_API_AUTH: 'REQUIRED', REQUEST_API_TOKEN: newToken()},
    {REQUEST_API_AUTH: 'disabled', REQUEST_API_TOKEN: newToken()},
    {REQUEST_API_AUTH: 'disabled'},
  ];
  for (const env of cases) {
    const store = countingStore();
    const base = await host(t, {store, env,
      logger: recordingLogger().logger});
    const label = JSON.stringify(env);
    const anonymous = await postRequest(base);
    assert.equal(anonymous.status, 503, label);
    assert.equal((await anonymous.json()).error.code,
        'API_AUTH_UNCONFIGURED', label);
    const withToken = await postRequest(base,
        {authorization: `Bearer ${env.REQUEST_API_TOKEN || newToken()}`});
    assert.equal(withToken.status, 503, label);
    assert.equal(store.calls.put, 0, label);
    assert.deepEqual(await modeGauge(base),
        {open: '0', enforced: '0', closed: '1'}, label);
  }
});

test('S6b valid settings choose open or enforced', async (t) => {
  const token = newToken();
  const cases = [
    {env: {}, mode: 'open', anonymousStatus: 201},
    {env: {REQUEST_API_AUTH: 'optional', REQUEST_API_TOKEN: token},
      mode: 'enforced', anonymousStatus: 401},
    {env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token},
      mode: 'enforced', anonymousStatus: 401},
    {env: {REQUEST_API_TOKEN: token}, mode: 'enforced', anonymousStatus: 401},
  ];
  for (const {env, mode, anonymousStatus} of cases) {
    const base = await host(t, {store: countingStore(), env,
      logger: recordingLogger().logger});
    const label = JSON.stringify(env);
    assert.equal((await postRequest(base)).status, anonymousStatus, label);
    const expected = {open: '0', enforced: '0', closed: '0'};
    assert.deepEqual(await modeGauge(base), {...expected, [mode]: '1'},
        label);
  }
});

test('S6c config keeps only a SHA-256 digest of the token', () => {
  const {readRequestApiAuthConfig} = require('../src/request-api-auth');
  const token = newToken();
  const config = readRequestApiAuthConfig(
      {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token});
  assert.equal(config.mode, 'enforced');
  assert.ok(Buffer.isBuffer(config.tokenDigest));
  assert.equal(config.tokenDigest.length, 32);
  assert.doesNotMatch(inspect(config, {depth: 5}), new RegExp(token));
  assert.ok(!config.tokenDigest.includes(Buffer.from(token)));
  assert.deepEqual(readRequestApiAuthConfig({}),
      {mode: 'open', tokenDigest: null});
  assert.deepEqual(readRequestApiAuthConfig({REQUEST_API_AUTH: 'required'}),
      {mode: 'closed', tokenDigest: null});
});

test('S7 without auth settings anonymous writes keep working', async (t) => {
  const store = countingStore();
  const base = await host(t, {store, env: {},
    logger: recordingLogger().logger});
  assert.equal((await postRequest(base)).status, 201);
  assert.equal((await fetch(`${base}/api/requests/${RECORD_ID}`)).status, 200);
});

test('S8 tokens never appear in responses, logs or metrics', async (t) => {
  const token = newToken();
  const presented = newToken();
  const {lines, logger} = recordingLogger();
  const seen = [];
  const base = await host(t, {store: countingStore(), logger,
    env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token}});
  const exchanges = [
    [await postRequest(base, {authorization: `Bearer ${presented}`}), 401],
    [await postRequest(base, {authorization: `Basic ${token}`}), 401],
    [await postRequest(base, {authorization: `Bearer ${token}`}), 201],
    [await fetch(`${base}/api/requests/${RECORD_ID}`,
        {headers: {authorization: `Bearer ${token}`}}), 200],
  ];
  for (const [response, status] of exchanges) {
    assert.equal(response.status, status);
    seen.push(await response.text(), JSON.stringify([...response.headers]));
  }
  seen.push(await (await fetch(`${base}/metrics`)).text(), ...lines);
  for (const secret of [token, presented]) {
    assert.ok(seen.every((text) => !text.includes(secret)));
  }
});

test('S9 mode gauge, reason counter and one startup warning', async (t) => {
  const enforcedLog = recordingLogger();
  const enforced = await host(t, {store: countingStore(),
    logger: enforcedLog.logger,
    env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: newToken()}});
  await postRequest(enforced);
  await postRequest(enforced, {authorization: `Bearer ${newToken()}`});
  assert.equal(await metricSample(enforced,
      'app_request_api_auth_rejected_total', 'reason="unauthorized"'), '2');
  assert.equal(await metricSample(enforced,
      'app_request_api_auth_rejected_total', 'reason="unconfigured"'), '0');
  assert.deepEqual(enforcedLog.lines, []);

  const closedLog = recordingLogger();
  const closed = await host(t, {store: countingStore(),
    logger: closedLog.logger, env: {REQUEST_API_AUTH: 'required'}});
  await postRequest(closed);
  await fetch(`${closed}/api/requests/${RECORD_ID}`);
  assert.equal(await metricSample(closed,
      'app_request_api_auth_rejected_total', 'reason="unconfigured"'), '2');
  assert.equal(await metricSample(closed,
      'app_request_api_auth_rejected_total', 'reason="unauthorized"'), '0');
  assert.equal(closedLog.lines.length, 1);
  assert.match(closedLog.lines[0], /^warn: .*auth unconfigured/);

  const openLog = recordingLogger();
  const open = await host(t, {store: countingStore(),
    logger: openLog.logger, env: {}});
  await postRequest(open);
  await postRequest(open);
  assert.equal(openLog.lines.length, 1);
  assert.match(openLog.lines[0], /^warn: .*unauthenticated/);
  assert.deepEqual(await modeGauge(open),
      {open: '1', enforced: '0', closed: '0'});
});

test('S10 a valid token keeps pause semantics: reads serve, writes 503',
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'ghost-auth-pause-'));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const file = join(directory, 'control.json');
      await writeFile(file, '{"writes_paused":false}');
      const token = newToken();
      const authorization = `Bearer ${token}`;
      const store = countingStore();
      const base = await host(t, {store, logger: recordingLogger().logger,
        env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token,
          APP_CONTROL_FILE: file}});
      const read = () => fetch(`${base}/api/requests/${RECORD_ID}`,
          {headers: {authorization}});
      const committed = await postRequest(base, {authorization});
      assert.equal(committed.status, 201);
      assert.equal((await committed.json()).status, 'committed');
      assert.equal((await read()).status, 200);
      await writeFile(file, '{"writes_paused":true}');
      const paused = await postRequest(base, {authorization});
      assert.equal(paused.status, 503);
      assert.equal((await paused.json()).error.code, 'WRITES_PAUSED');
      assert.equal((await read()).status, 200);
    });

test('S11 path case, trailing slash and other methods cannot bypass',
    async (t) => {
      const store = countingStore();
      const base = await host(t, {store, logger: recordingLogger().logger,
        env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: newToken()}});
      const json = {'content-type': 'application/json'};
      for (const [method, path] of [
        ['POST', '/API/REQUESTS'], ['POST', '/api/requests/'],
        ['GET', `/api/requests/${RECORD_ID}/`],
        ['HEAD', `/api/requests/${RECORD_ID}`],
        ['DELETE', `/api/requests/${RECORD_ID}`],
        ['PUT', `/Api/Requests/${RECORD_ID}`],
      ]) {
        const body = method === 'POST' || method === 'PUT' ? '{}' : undefined;
        const response = await fetch(`${base}${path}`,
            {method, headers: json, body});
        assert.equal(response.status, 401, `${method} ${path}`);
      }
      assert.deepEqual(store.calls,
          {put: 0, get: 0, status: 0, checkReady: 0});
    });

test('S12 a valid token reaches the JSON parser', async (t) => {
  const token = newToken();
  const store = countingStore();
  const base = await host(t, {store, logger: recordingLogger().logger,
    env: {REQUEST_API_AUTH: 'required', REQUEST_API_TOKEN: token}});
  const response = await postRequest(base,
      {authorization: `Bearer ${token}`}, '{broken');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  assert.equal(store.calls.put, 0);
});
