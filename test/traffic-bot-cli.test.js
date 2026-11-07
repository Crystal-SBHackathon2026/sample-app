const {readLedger} = require('./bot-ledger-reader');
// Runs the bot CLI as an operator would. The ledger lock needs Linux (or a
// compatible flock(1)); run these in the pinned node:22 Linux image.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {createServer} = require('node:http');
const {openLedger} = require('../packages/traffic-bot');

const BIN = path.resolve(__dirname,
    '../packages/traffic-bot/bin/traffic-bot.js');
const {isTokenTransportAllowed, readBotApiToken} = require(BIN);
const CLI_TIMEOUT_MS = 20000;
const GENERIC_FAILURE = 'check configuration';
/**
 * Calls main() with an env that differs from the child's real process env
 * only in NODE_TLS_REJECT_UNAUTHORIZED: 'inject' adds '0', 'strip' drops it.
 */
const TLS_ENV_RUNNER = `
const [bin, mode] = process.argv.slice(1);
const {NODE_TLS_REJECT_UNAUTHORIZED: unused, ...rest} = process.env;
const env = mode === 'inject' ?
  {...rest, NODE_TLS_REJECT_UNAUTHORIZED: '0'} : rest;
require(bin).main(env).catch((error) => {
  console.error('traffic-bot startup failed: ' + error.code);
  process.exitCode = 1;
});`;

/** A unique dummy credential; never a real team token. */
function testToken() {
  return `test-token-${randomUUID()}`;
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-cli-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const {port} = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
/**
 * Serves the committed-envelope contract for whatever the bot sends. With
 * `token`, a request without exactly that Bearer token gets 401. `traffic`
 * counts TCP connections and records each request's method and header.
 */
async function serveStore(t, {token, host = '127.0.0.1',
  traffic = {connections: 0, requests: []}} = {}) {
  const stored = new Map();
  const server = createServer(async (req, res) => {
    traffic.requests.push({method: req.method,
      authorization: req.headers.authorization});
    res.setHeader('Content-Type', 'application/json');
    if (token !== undefined &&
        req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      return res.end('{}');
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      const request = JSON.parse(body);
      stored.set(request.request_id, request);
      res.writeHead(201);
      return res.end(JSON.stringify(envelope(request)));
    }
    const request = stored.get(decodeURIComponent(req.url.split('/').pop()));
    if (!request) {
      res.writeHead(404);
      return res.end('{}');
    }
    res.end(JSON.stringify(envelope(request)));
  });
  server.on('connection', () => {
    traffic.connections++;
  });
  server.listen(0, host);
  await once(server, 'listening');
  t.after(() => server.close());
  const address = host.includes(':') ? `[${host}]` : host;
  return `http://${address}:${server.address().port}`;
}
function envelope(request) {
  return {status: 'committed', request, environment: 'local',
    database: {name: 'migration_demo'}};
}

/** Starts the CLI; result resolves with exit code and captured output. */
async function startCli(env, args = [BIN]) {
  const child = spawn(process.execPath, args, {
    env: {PATH: process.env.PATH, BOT_METRICS_HOST: '127.0.0.1',
      BOT_METRICS_PORT: String(await freePort()), ...env},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), CLI_TIMEOUT_MS);
  const result = once(child, 'close').then(([code, signal]) => {
    clearTimeout(timer);
    return {code, signal, stdout, stderr};
  });
  return {child, result};
}
function lastFatal(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map((line) =>
    JSON.parse(line)).reverse().find((summary) => summary.fatal)?.fatal;
}
/** Polls ledger.json until `predicate(entries)` holds; bounded wait. */
async function waitForLedger(dir, predicate) {
  const deadline = Date.now() + CLI_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = await readLedger(dir)
        .catch(() => '');
    if (text && predicate(JSON.parse(text).entries)) {
      return JSON.parse(text).entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('ledger condition not reached');
}
/**
 * Asserts a startup refusal with `code` that happened before any ledger
 * file, connection or request, and printed no secret or URL.
 */
async function assertRefusedBeforeStart(result, {code, ledgerDir, traffic,
  hidden}) {
  const {code: exitCode, stdout, stderr} = await result;
  assert.equal(exitCode, 1);
  assert.match(stderr, new RegExp(`traffic-bot startup failed: ${code}\\b`));
  await assert.rejects(fs.stat(ledgerDir), {code: 'ENOENT'});
  assert.equal(traffic.connections, 0);
  assert.deepEqual(traffic.requests, []);
  for (const value of hidden.filter(Boolean)) {
    assert.ok(!`${stdout}${stderr}`.includes(value));
  }
}
function newTraffic() {
  return {connections: 0, requests: []};
}
/** Runs the CLI until `predicate(entries)` holds, then stops it. */
async function runUntil(env, predicate) {
  const {child, result} = await startCli(env);
  try {
    await waitForLedger(env.BOT_LEDGER_DIR, predicate);
  } finally {
    child.kill('SIGTERM');
  }
  return result;
}

test('CLI refuses to start without BOT_RUN_ID and creates no ledger',
    async (t) => {
      const parent = await fixture(t);
      const ledgerDir = path.join(parent, 'ledger');
      const {result} = await startCli({BOT_BASE_URL: 'http://127.0.0.1:9',
        BOT_LEDGER_DIR: ledgerDir});
      const {code, stderr} = await result;
      assert.equal(code, 1);
      assert.match(stderr, new RegExp(GENERIC_FAILURE));
      assert.ok(!stderr.includes(parent));
      await assert.rejects(fs.stat(ledgerDir), {code: 'ENOENT'});
    });

test('CLI prints only allow-listed lock codes, never paths', async (t) => {
  const cases = {
    LEDGER_OWNED: async (dir, t) => {
      const ledger = await openLedger({dir});
      t.after(() => ledger.close());
      return {};
    },
    LEDGER_LEGACY_LOCK: async (dir, t) => {
      const legacy = `${await fs.realpath(dir)}.lock`;
      await fs.mkdir(legacy);
      t.after(() => fs.rm(legacy, {recursive: true, force: true}));
      return {};
    },
    LEDGER_LOCK_UNSUPPORTED: async (dir, t) => ({PATH: await fixture(t)}),
  };
  for (const [expected, arrange] of Object.entries(cases)) {
    await t.test(expected, {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
      const dir = await fixture(t);
      const env = await arrange(dir, t);
      const {result} = await startCli({BOT_BASE_URL: 'http://127.0.0.1:9',
        BOT_LEDGER_DIR: dir, BOT_RUN_ID: 'cli_test', ...env});
      const {code, stderr} = await result;
      assert.equal(code, 1);
      assert.match(stderr, new RegExp(`\\b${expected}\\b`));
      assert.ok(!stderr.includes(dir));
    });
  }
});

test('CLI reports a replaced lock file as fatal LEDGER_LOCK_LOST',
    {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
      const dir = await fixture(t);
      const {result} = await startCli({BOT_BASE_URL: await serveStore(t),
        BOT_LEDGER_DIR: dir, BOT_RUN_ID: 'cli_test', BOT_RATE: '20'});
      const ledgerFile = path.join(dir, 'ledger.json');
      for (;;) {
        const text = await readLedger(dir).catch(() => '');
        if (text && JSON.parse(text).entries.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lockFile = path.join(dir, '.owner.lock');
      await fs.writeFile(`${lockFile}.new`, '{}');
      await fs.rename(`${lockFile}.new`, lockFile);
      const {code, stdout, stderr} = await result;
      assert.equal(code, 1);
      assert.equal(lastFatal(stdout), 'LEDGER_LOCK_LOST');
      assert.ok(!stderr.includes(dir));
    });

test('CLI hides configuration secrets behind the generic failure',
    async (t) => {
      const dir = await fixture(t);
      const {result} = await startCli({
        BOT_BASE_URL: 'http://user:s3cr3t-token@127.0.0.1:9',
        BOT_LEDGER_DIR: dir, BOT_RUN_ID: 'cli_test'});
      const {code, stdout, stderr} = await result;
      assert.equal(code, 1);
      assert.match(stderr, new RegExp(GENERIC_FAILURE));
      assert.ok(!`${stdout}${stderr}`.includes('s3cr3t-token'));
    });

test('CLI default record limit stops generation at 10000 entries',
    {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
      const dir = await fixture(t);
      const entries = Array.from({length: 10000}, (unused, index) => ({
        request: {request_id: randomUUID(), run_id: 'cli_test',
          phase: 'onprem_live', request_no: String(index + 1),
          payload: 'old', created_at: new Date().toISOString()},
        state: 'committed', attempts: 1, enqueuedAt: 1, nextAttemptAt: 0,
        observations: []}));
      await fs.writeFile(path.join(dir, 'ledger.json'),
          JSON.stringify({version: 1, entries}));
      const {result} = await startCli({BOT_BASE_URL: await serveStore(t),
        BOT_LEDGER_DIR: dir, BOT_RUN_ID: 'cli_test'});
      const {code, stdout} = await result;
      assert.equal(code, 1);
      assert.equal(lastFatal(stdout), 'LEDGER_GENERATION_LIMIT_OR_IO_ERROR');
      const saved = JSON.parse(
          await readLedger(dir));
      assert.equal(saved.entries.length, 10000);
    });

test('B1c token transport allows only HTTPS or exact loopback HTTP', () => {
  // [URL, WHATWG-normalized hostname, allowed]
  const cases = [
    ['https://example.invalid', 'example.invalid', true],
    ['http://127.0.0.1:1', '127.0.0.1', true],
    ['http://[::1]:1', '[::1]', true],
    ['http://[0:0:0:0:0:0:0:1]', '[::1]', true],
    ['http://127.1', '127.0.0.1', true],
    ['http://127.0.0.1.example.invalid', '127.0.0.1.example.invalid', false],
    ['http://localhost.example.invalid', 'localhost.example.invalid', false],
    ['http://[::ffff:127.0.0.1]', '[::ffff:7f00:1]', false],
    ['http://0.0.0.0', '0.0.0.0', false],
    ['http://127.0.0.2', '127.0.0.2', false],
    ['http://LOCALHOST', 'localhost', false],
  ];
  for (const [url, hostname, allowed] of cases) {
    assert.equal(new URL(url).hostname, hostname, url);
    assert.equal(isTokenTransportAllowed(url, {}), allowed, url);
  }
});

test('B6/B8 token transport refuses only NODE_TLS_REJECT_UNAUTHORIZED=0',
    () => {
      const disabled = {NODE_TLS_REJECT_UNAUTHORIZED: '0'};
      assert.equal(isTokenTransportAllowed('https://example.invalid',
          disabled), false);
      assert.equal(isTokenTransportAllowed('http://127.0.0.1:1', disabled),
          false);
      for (const value of ['1', '', 'false']) {
        assert.equal(isTokenTransportAllowed('https://example.invalid',
            {NODE_TLS_REJECT_UNAUTHORIZED: value}), true, value);
      }
    });

test('B3 BOT_API_TOKEN must be unset or a 32+ char RFC 6750 b64token', () => {
  assert.equal(readBotApiToken({}), undefined);
  const valid = ['a'.repeat(32), `${'A1-._~+/'.repeat(4)}==`, testToken()];
  for (const token of valid) {
    assert.equal(readBotApiToken({BOT_API_TOKEN: token}), token);
  }
  const invalid = ['', 'a'.repeat(31), `${'a'.repeat(16)} ${'a'.repeat(16)}`,
    `${'a'.repeat(32)}!`, `${'a'.repeat(16)}=${'a'.repeat(16)}`];
  for (const token of invalid) {
    assert.throws(() => readBotApiToken({BOT_API_TOKEN: token}), (error) =>
      error.code === 'BOT_API_TOKEN_INVALID' &&
      (token === '' || !error.message.includes(token)));
  }
});

test('B3 CLI refuses an empty or malformed BOT_API_TOKEN before the ledger',
    async (t) => {
      const tokens = {'empty': '', '31 chars': testToken().slice(0, 31),
        'space': `${testToken()} x`, 'bang': `${testToken()}!`};
      for (const [name, token] of Object.entries(tokens)) {
        await t.test(name, {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
          const traffic = newTraffic();
          const baseUrl = await serveStore(t, {traffic});
          const ledgerDir = path.join(await fixture(t), 'ledger');
          const {result} = await startCli({BOT_BASE_URL: baseUrl,
            BOT_LEDGER_DIR: ledgerDir, BOT_RUN_ID: 'cli_test',
            BOT_API_TOKEN: token});
          await assertRefusedBeforeStart(result, {
            code: 'BOT_API_TOKEN_INVALID', ledgerDir, traffic,
            hidden: [token, baseUrl]});
        });
      }
    });

test('B1 CLI refuses to send a token over non-loopback HTTP', async (t) => {
  const cases = {
    'localhost': {listen: '127.0.0.1', target: 'localhost'},
    'B1b 127.0.0.2': {listen: '0.0.0.0', target: '127.0.0.2'},
  };
  for (const [name, {listen, target}] of Object.entries(cases)) {
    await t.test(name, {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
      const token = testToken();
      const traffic = newTraffic();
      const local = await serveStore(t, {host: listen, traffic});
      const baseUrl = `http://${target}:${new URL(local).port}`;
      const ledgerDir = path.join(await fixture(t), 'ledger');
      const {result} = await startCli({BOT_BASE_URL: baseUrl,
        BOT_LEDGER_DIR: ledgerDir, BOT_RUN_ID: 'cli_test',
        BOT_API_TOKEN: token});
      await assertRefusedBeforeStart(result, {
        code: 'INSECURE_TOKEN_TRANSPORT', ledgerDir, traffic,
        hidden: [token, baseUrl]});
    });
  }
});

test('B6/B7 CLI refuses a token when TLS verification is disabled',
    async (t) => {
      const cases = {
        'B6 injected env': {mode: 'inject', processEnv: {}},
        'B7 real process env': {mode: 'strip',
          processEnv: {NODE_TLS_REJECT_UNAUTHORIZED: '0'}},
      };
      for (const [name, {mode, processEnv}] of Object.entries(cases)) {
        await t.test(name, {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
          const token = testToken();
          const traffic = newTraffic();
          const local = await serveStore(t, {traffic});
          const baseUrl = `https://127.0.0.1:${new URL(local).port}`;
          const ledgerDir = path.join(await fixture(t), 'ledger');
          const {result} = await startCli({BOT_BASE_URL: baseUrl,
            BOT_LEDGER_DIR: ledgerDir, BOT_RUN_ID: 'cli_test',
            BOT_API_TOKEN: token, ...processEnv},
          ['-e', TLS_ENV_RUNNER, BIN, mode]);
          await assertRefusedBeforeStart(result, {
            code: 'INSECURE_TOKEN_TRANSPORT', ledgerDir, traffic,
            hidden: [token, baseUrl]});
        });
      }
    });

test('B2 CLI sends the Bearer token on every POST and GET over loopback',
    async (t) => {
      const cases = {
        '127.0.0.1': {host: '127.0.0.1', env: {}},
        'B2b [::1]': {host: '::1', env: {}},
        'B8 NODE_TLS_REJECT_UNAUTHORIZED=1': {host: '127.0.0.1',
          env: {NODE_TLS_REJECT_UNAUTHORIZED: '1'}},
      };
      for (const [name, {host, env}] of Object.entries(cases)) {
        await t.test(name, {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
          const token = testToken();
          const traffic = newTraffic();
          const baseUrl = await serveStore(t, {token, host, traffic});
          const dir = await fixture(t);
          const {stdout, stderr} = await runUntil({BOT_BASE_URL: baseUrl,
            BOT_LEDGER_DIR: dir, BOT_RUN_ID: 'cli_test', BOT_RATE: '20',
            BOT_API_TOKEN: token, ...env},
          (entries) => entries.some((entry) => entry.state === 'committed'));
          const methods = new Set(traffic.requests.map(({method}) => method));
          assert.deepEqual([...methods].sort(), ['GET', 'POST']);
          for (const {authorization} of traffic.requests) {
            assert.equal(authorization, `Bearer ${token}`);
          }
          const ledger = await readLedger(dir);
          assert.ok(!`${stdout}${stderr}${ledger}`.includes(token));
        });
      }
    });

test('B4 CLI without BOT_API_TOKEN keeps the unauthenticated behaviour',
    async (t) => {
      await t.test('loopback store commits with no authorization header',
          {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
            const traffic = newTraffic();
            const baseUrl = await serveStore(t, {traffic});
            await runUntil({BOT_BASE_URL: baseUrl,
              BOT_LEDGER_DIR: await fixture(t), BOT_RUN_ID: 'cli_test',
              BOT_RATE: '20'},
            (entries) => entries.some((entry) => entry.state === 'committed'));
            assert.ok(traffic.requests.length >= 2);
            for (const {authorization} of traffic.requests) {
              assert.equal(authorization, undefined);
            }
          });
      await t.test('plain HTTP elsewhere is not transport-checked',
          {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
            // A non-loopback literal (RFC 5737) fails fast without DNS.
            const {stderr} = await runUntil({
              BOT_BASE_URL: 'http://192.0.2.1:9',
              BOT_LEDGER_DIR: await fixture(t), BOT_RUN_ID: 'cli_test'},
            (entries) => entries.some((entry) => entry.state === 'pending' &&
              entry.lastError === 'HTTP_TRANSPORT_ERROR'));
            assert.ok(!stderr.includes('INSECURE_TOKEN_TRANSPORT'));
          });
    });

test('B5 CLI records a rejected token as failed HTTP_401 without the secret',
    {timeout: CLI_TIMEOUT_MS * 2}, async (t) => {
      const token = testToken();
      const traffic = newTraffic();
      const baseUrl = await serveStore(t, {token: testToken(), traffic});
      const dir = await fixture(t);
      const {stdout, stderr} = await runUntil({BOT_BASE_URL: baseUrl,
        BOT_LEDGER_DIR: dir, BOT_RUN_ID: 'cli_test', BOT_API_TOKEN: token},
      (entries) => entries.some((entry) => entry.state === 'failed'));
      const ledger = await readLedger(dir);
      const failed = JSON.parse(ledger).entries.filter(
          ({state}) => state === 'failed');
      assert.ok(failed.length >= 1);
      for (const {lastError} of failed) {
        assert.equal(lastError, 'HTTP_401');
      }
      assert.ok(traffic.requests.length >= 1);
      for (const {authorization} of traffic.requests) {
        assert.equal(authorization, `Bearer ${token}`);
      }
      assert.ok(!`${stdout}${stderr}${ledger}`.includes(token));
    });
