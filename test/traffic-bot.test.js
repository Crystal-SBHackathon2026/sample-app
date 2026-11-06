const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {createServer} = require('node:http');
const {
  createTrafficBot, createHttpAdapter, openLedger,
} = require('../packages/traffic-bot');

const RUN_ID = 'test';
const MIB = 1024 * 1024;

function record() {
  return {request_id: randomUUID(), run_id: RUN_ID, phase: 'onprem_live',
    request_no: '1', payload: 'test', created_at: new Date().toISOString()};
}
function envelope(request) {
  return {status: 'committed', request, environment: 'local',
    database: {name: 'migration_demo'}};
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-bot-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}
async function savedEntries(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, 'ledger.json'))).entries;
}
async function writeLedger(dir, entries) {
  await fs.writeFile(path.join(dir, 'ledger.json'),
      JSON.stringify({version: 1, entries}));
}
function committedEntry(index) {
  return {request: {...record(), request_no: String(index)},
    state: 'committed', attempts: 1, enqueuedAt: 1, nextAttemptAt: 0,
    observations: []};
}

test('ledger persists requests before send and resumes pending after reopen',
    async (t) => {
      const dir = await fixture(t);
      const request = record();
      const first = await openLedger({dir});
      await first.add(request);
      await first.close();
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        adapter: {
          write: async (value) => envelope(value),
          read: async () => envelope(request),
        }});
      await bot.processPending();
      assert.equal(bot.snapshot().committed, 1);
      await bot.stop();
      const saved = JSON.parse(
          await fs.readFile(path.join(dir, 'ledger.json')));
      assert.deepEqual(saved.entries[0].request, request);
      assert.equal(saved.entries[0].state, 'committed');
      assert.equal(saved.entries[0].observations[0].environment, 'local');
    });

test('lost write response is reconciled through GET with the same ID',
    async (t) => {
      const dir = await fixture(t);
      let stored;
      let writes = 0;
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        retryDelayMs: 1, adapter: {
          write: async (request) => {
            writes++;
            stored = request;
            throw new Error('socket lost');
          },
          read: async (id) => {
            assert.equal(id, stored.request_id);
            return envelope(stored);
          },
        }});
      const request = record();
      await bot.enqueue(request);
      await bot.processPending();
      assert.equal(writes, 1);
      assert.equal(bot.snapshot().committed, 1);
      assert.match(bot.metrics(),
          /traffic_bot_requests_total\{state="committed"\} 1/);
      await bot.stop();
    });

test('retry keeps the immutable body; POST content mismatch is unconfirmed',
    async (t) => {
      const dir = await fixture(t);
      const sent = [];
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        retryDelayMs: 1, adapter: {
          write: async (request) => {
            sent.push(structuredClone(request));
            if (sent.length === 1) throw new Error('temporary');
            return envelope({...request, payload: 'different'});
          },
          read: async () => null,
        }});
      await bot.enqueue(record());
      await bot.processPending();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await bot.processPending();
      assert.deepEqual(sent[0], sent[1]);
      assert.equal(bot.snapshot().failed, 0);
      assert.equal(bot.snapshot().pending, 1);
      await bot.stop();
      assert.equal((await savedEntries(dir))[0].lastError, 'RESPONSE_INVALID');
    });

test('single writer lock and bounded pending queue reject extra work',
    async (t) => {
      const dir = await fixture(t);
      const ledger = await openLedger({dir, maxPending: 1});
      await assert.rejects(openLedger({dir}),
          (error) => error.code === 'LEDGER_OWNED');
      await ledger.add(record());
      await assert.rejects(ledger.add(record()), /limit/);
      await ledger.close();
    });

test('HTTP adapter writes and reads contract; permanent 409 is explicit',
    async (t) => {
      const request = record();
      let conflict = false;
      const baseUrl = await serve(t, async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (conflict) {
          res.writeHead(409);
          return res.end(JSON.stringify({error: {code: 'REQUEST_CONFLICT'}}));
        }
        if (req.method === 'POST') {
          assert.deepEqual(JSON.parse(await readBody(req)), request);
          res.writeHead(201);
        }
        res.end(JSON.stringify(envelope(request)));
      });
      const adapter = createHttpAdapter({baseUrl});
      assert.equal((await adapter.write(request)).request.request_id,
          request.request_id);
      assert.equal((await adapter.read(request.request_id)).request.payload,
          request.payload);
      conflict = true;
      await assert.rejects(adapter.write(request), (error) => error.terminal);
    });

test('HTTP adapter marks unreadable 2xx bodies as after-response, not terminal',
    async (t) => {
      let reply = 'not json';
      const baseUrl = await serve(t, async (req, res) => {
        await readBody(req);
        res.writeHead(201, {'Content-Type': 'application/json'});
        res.end(reply);
      });
      const adapter = createHttpAdapter({baseUrl, maxResponseBytes: 64});
      for (const [body, code] of [['not json', 'INVALID_JSON_RESPONSE'],
        ['x'.repeat(65), 'RESPONSE_TOO_LARGE']]) {
        reply = body;
        await assert.rejects(adapter.write(record()), (error) =>
          error.code === code && error.afterResponse === true &&
          !error.terminal);
      }
    });

const EXPECTED_BASE = 'https://expected.invalid';
// URL parsing turns a raw backslash into '/' and drops tab/CR/LF, so each of
// these could become '//other.invalid' (another host) or hide a rewrite.
const UNSAFE_REQUEST_PATHS = [
  '/\\other.invalid/probe',
  '/\\\\other.invalid/probe',
  '/\r\n/other.invalid/probe',
  '/\n/other.invalid/probe',
  '/\t/other.invalid/probe',
  '/\t\\other.invalid/probe',
  '/api\\requests',
  '/api/requests\r\nX-Injected: 1',
  '/api/requests ',
  '/\u0000/other.invalid',
];

function fetchCall(url, init) {
  return {url: String(url), authorization: init.headers.authorization};
}

test('HTTP adapter refuses request paths that could leave the baseUrl origin',
    async (t) => {
      const sent = [];
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        sent.push(fetchCall(url, init));
        throw new Error('test double: no network');
      });
      const accepted = [];
      for (const requestsPath of UNSAFE_REQUEST_PATHS) {
        let adapter;
        try {
          adapter = createHttpAdapter({baseUrl: EXPECTED_BASE, requestsPath,
            headers: {authorization: 'Bearer test-only'}});
        } catch (error) {
          assert.ok(error instanceof TypeError, JSON.stringify(requestsPath));
          continue;
        }
        accepted.push(requestsPath);
        await adapter.write(record()).catch(() => {});
      }
      assert.deepEqual({accepted, sent}, {accepted: [], sent: []});
    });

test('HTTP adapter keeps default and custom same-origin request paths',
    async (t) => {
      const request = record();
      const sent = [];
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        sent.push(fetchCall(url, init));
        return new Response(JSON.stringify(envelope(request)), {status: 201});
      });
      const headers = {authorization: 'Bearer test-only'};
      const cases = [
        [undefined, `${EXPECTED_BASE}/api/requests`],
        ['/probe/v1/requests/', `${EXPECTED_BASE}/probe/v1/requests`],
        ['/probe%5Cv1', `${EXPECTED_BASE}/probe%5Cv1`],
      ];
      for (const [requestsPath, endpoint] of cases) {
        sent.length = 0;
        const adapter = createHttpAdapter({baseUrl: EXPECTED_BASE,
          requestsPath, headers});
        await adapter.write(request);
        await adapter.read('id 1');
        assert.deepEqual(sent, [
          {url: endpoint, authorization: headers.authorization},
          {url: `${endpoint}/id%201`, authorization: headers.authorization},
        ]);
      }
      assert.throws(() => createHttpAdapter({
        baseUrl: `${EXPECTED_BASE}/?next=1`}), TypeError);
    });

test('2xx POST that cannot be validated is committed by a matching GET',
    async (t) => {
      const cases = {
        'invalid JSON': (res) => res.end('not json'),
        'oversized body': (res) => res.end('x'.repeat(600 * 1024)),
        'different six fields': (res, stored) => res.end(JSON.stringify(
            envelope({...stored, payload: 'other'}))),
        'invalid envelope shape': (res) => res.end('{"status":"ok"}'),
      };
      for (const [name, reply] of Object.entries(cases)) {
        await t.test(name, async (t) => {
          const dir = await fixture(t);
          let stored;
          let writes = 0;
          const baseUrl = await serve(t, async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'GET') {
              return res.end(JSON.stringify(envelope(stored)));
            }
            writes++;
            stored = JSON.parse(await readBody(req));
            res.writeHead(201);
            reply(res, stored);
          });
          const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
            retryDelayMs: 1, adapter: createHttpAdapter({baseUrl})});
          await bot.enqueue(record());
          await bot.processPending();
          assert.equal(writes, 1);
          assert.equal(bot.snapshot().committed, 1);
          assert.equal(bot.snapshot().failed, 0);
          await bot.stop();
          assert.equal((await savedEntries(dir))[0].observations.length, 1);
        });
      }
    });

test('unreadable 2xx POST with a different GET record is a content conflict',
    async (t) => {
      const dir = await fixture(t);
      let stored;
      const baseUrl = await serve(t, async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          return res.end(JSON.stringify(
              envelope({...stored, payload: 'someone else'})));
        }
        stored = JSON.parse(await readBody(req));
        res.writeHead(201);
        res.end('not json');
      });
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        retryDelayMs: 1, adapter: createHttpAdapter({baseUrl})});
      await bot.enqueue(record());
      await bot.processPending();
      assert.equal(bot.snapshot().failed, 1);
      await bot.stop();
      assert.equal((await savedEntries(dir))[0].lastError, 'CONTENT_CONFLICT');
    });

test('unreadable 2xx POST whose GET never confirms ends unknown, not failed',
    async (t) => {
      const dir = await fixture(t);
      const readReplies = [
        (res) => { res.writeHead(404); res.end('{}'); },
        (res) => res.end('not json'),
        (res) => { res.writeHead(400); res.end('{}'); },
      ];
      let reads = 0;
      let writes = 0;
      const baseUrl = await serve(t, async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          return readReplies[reads++ % readReplies.length](res);
        }
        writes++;
        await readBody(req);
        res.writeHead(201);
        res.end('not json');
      });
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        maxAttempts: 2, retryDelayMs: 1,
        adapter: createHttpAdapter({baseUrl})});
      await bot.enqueue(record());
      for (let count = 0; count < 8 && !bot.snapshot().unknown; count++) {
        await bot.processPending();
        assert.equal(bot.snapshot().failed, 0);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(writes, 2);
      assert.ok(reads >= 3);
      assert.equal(bot.snapshot().unknown, 1);
      assert.equal(bot.snapshot().failed, 0);
      await bot.stop();
    });

test('unreadable 2xx POST stays pending across restart and is reconciled',
    async (t) => {
      const dir = await fixture(t);
      let stored;
      let readable = false;
      const baseUrl = await serve(t, async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          if (!readable) {
            res.writeHead(503);
            return res.end('{}');
          }
          return res.end(JSON.stringify(envelope(stored)));
        }
        stored = JSON.parse(await readBody(req));
        res.writeHead(201);
        res.end('not json');
      });
      const options = {ledgerDir: dir, runId: RUN_ID, retryDelayMs: 1,
        adapter: createHttpAdapter({baseUrl})};
      const first = await createTrafficBot(options);
      await first.enqueue(record());
      await first.processPending();
      assert.equal(first.snapshot().pending, 1);
      await first.stop();
      const [entry] = await savedEntries(dir);
      assert.equal(entry.state, 'pending');
      assert.equal(entry.lastError, 'INVALID_JSON_RESPONSE');
      readable = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await createTrafficBot({...options,
        adapter: {...createHttpAdapter({baseUrl}),
          write: async () => assert.fail('reconcile before a new POST')}});
      await second.processPending();
      assert.equal(second.snapshot().committed, 1);
      await second.stop();
    });

test('explicit POST 400 and 409 refusals fail immediately without GET',
    async (t) => {
      for (const status of [400, 409]) {
        await t.test(`HTTP ${status}`, async (t) => {
          const dir = await fixture(t);
          let reads = 0;
          const baseUrl = await serve(t, async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'GET') {
              reads++;
              return res.end('{}');
            }
            await readBody(req);
            res.writeHead(status);
            res.end('{}');
          });
          const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
            adapter: createHttpAdapter({baseUrl})});
          await bot.enqueue(record());
          await bot.processPending();
          assert.equal(bot.snapshot().failed, 1);
          assert.equal(reads, 0);
          await bot.stop();
        });
      }
    });

test('SDK refuses a missing or malformed runId before creating a ledger',
    async (t) => {
      const parent = await fixture(t);
      const adapter = {write: async () => null, read: async () => null};
      for (const runId of [undefined, '', 'has space', 'x'.repeat(201),
        'slash/not-allowed']) {
        const ledgerDir = path.join(parent, 'ledger');
        await assert.rejects(createTrafficBot({ledgerDir, adapter, runId}),
            TypeError);
        await assert.rejects(fs.stat(ledgerDir), {code: 'ENOENT'});
      }
    });

test('a new runId keeps old pending bodies and numbers its own from 1',
    async (t) => {
      const dir = await fixture(t);
      const old = {...record(), run_id: 'run_a', request_no: '7'};
      const ledger = await openLedger({dir});
      await ledger.add(old);
      await ledger.close();
      const sent = [];
      const bot = await createTrafficBot({ledgerDir: dir, runId: 'run_b',
        ratePerSecond: 100, adapter: {
          write: async (request) => {
            sent.push(structuredClone(request));
            return envelope(request);
          },
          read: async (id) => envelope(sent.find((item) =>
            item.request_id === id)),
        }});
      void bot.start();
      while (bot.snapshot().committed < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await bot.stop();
      assert.deepEqual(sent[0], old);
      assert.deepEqual(sent.slice(1).map((item) => item.run_id),
          sent.slice(1).map(() => 'run_b'));
      assert.equal(sent[1].request_no, '1');
      assert.deepEqual((await savedEntries(dir))[0].request, old);
    });

test('attempt cap still reconciles an ambiguous final attempt before failure',
    async (t) => {
      const dir = await fixture(t);
      let writes = 0;
      let readable = false;
      let stored;
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        maxAttempts: 1, retryDelayMs: 1, adapter: {
          write: async (request) => {
            writes++;
            stored = request;
            throw new Error('ambiguous');
          },
          read: async () => readable ? envelope(stored) : null,
        }});
      await bot.enqueue(record());
      await bot.processPending();
      readable = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await bot.processPending();
      assert.equal(writes, 1);
      assert.equal(bot.snapshot().committed, 1);
      await bot.stop();
    });

test('request age and record limits fail visibly without sending new bodies',
    async (t) => {
      const dir = await fixture(t);
      const ledger = await openLedger({dir, maxRecords: 1});
      const request = record();
      await ledger.add(request);
      await assert.rejects(ledger.add(record()), /limit/);
      await ledger.close();
      let writes = 0;
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        maxRequestAgeMs: 1, adapter: {
          write: async () => { writes++; }, read: async () => null,
        }});
      await new Promise((resolve) => setTimeout(resolve, 5));
      await bot.processPending();
      assert.equal(bot.snapshot().failed, 1);
      assert.equal(writes, 0);
      await bot.stop();
      const saved = JSON.parse(
          await fs.readFile(path.join(dir, 'ledger.json')));
      assert.equal(saved.entries[0].lastError, 'REQUEST_EXPIRED');
    });

test('default record limit rejects the 10001st ledger and SDK entry',
    async (t) => {
      const dir = await fixture(t);
      await writeLedger(dir, Array.from({length: 10000}, (unused, index) =>
        committedEntry(index + 1)));
      const ledger = await openLedger({dir});
      await assert.rejects(ledger.add(record()), /record limit/);
      await ledger.close();
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        adapter: {write: async () => null, read: async () => null}});
      await assert.rejects(bot.enqueue(record()), /record limit/);
      await bot.stop();
      assert.equal((await savedEntries(dir)).length, 10000);
    });

test('default 8MiB size limit rejects oversized ledgers; persist is timed',
    async (t) => {
      const dir = await fixture(t);
      const payload = 'p'.repeat(60 * 1024);
      const entries = Array.from({length: 135}, (unused, index) => ({
        ...committedEntry(index + 1),
        request: {...committedEntry(index + 1).request, payload},
      }));
      await writeLedger(dir, entries);
      const size = (await fs.stat(path.join(dir, 'ledger.json'))).size;
      assert.ok(size < 8 * MIB && size > 8 * MIB - 2 * payload.length);
      const ledger = await openLedger({dir});
      const started = process.hrtime.bigint();
      await ledger.update(entries[0].request.request_id, {lastError: null});
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      t.diagnostic(`8MiB-class persist: ${size} bytes in ` +
          `${elapsedMs.toFixed(1)} ms`);
      await assert.rejects(ledger.add({...record(), payload}),
          /size limit/);
      await ledger.close();
      await fs.appendFile(path.join(dir, 'ledger.json'),
          ' '.repeat(8 * MIB - size + 1));
      await assert.rejects(openLedger({dir}), /size limit/);
    });

test('stop promptly wakes a low-rate runner and preserves in-flight requests',
    async (t) => {
      const dir = await fixture(t);
      let stored;
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        ratePerSecond: 0.001, adapter: {
          write: async (request) => {
            stored = request;
            return envelope(request);
          },
          read: async () => envelope(stored),
        }});
      void bot.start();
      while (!bot.snapshot().committed) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const started = Date.now();
      await bot.stop();
      assert.ok(Date.now() - started < 1000);
      assert.equal(bot.snapshot().committed, 1);
    });

test('CLI numeric environment values reject blank, NaN, fractional counts',
    () => {
      const {numeric} = require('../packages/traffic-bot/bin/traffic-bot');
      for (const value of ['', 'NaN', '-1', 'Infinity', '1.5']) {
        assert.throws(() => numeric({BOT_MAX_PENDING: value},
            'BOT_MAX_PENDING', 10));
      }
    });

test('expired ambiguous POST is reconciled after restart, not falsely failed',
    async (t) => {
      const dir = await fixture(t);
      const request = record();
      const first = await openLedger({dir});
      await first.add(request);
      await first.update(request.request_id, {attempts: 1});
      await first.close();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        maxRequestAgeMs: 1, adapter: {
          write: async () => assert.fail('expired must not POST'),
          read: async () => envelope(request)}});
      await bot.processPending();
      assert.equal(bot.snapshot().committed, 1);
      assert.equal(bot.snapshot().failed, 0);
      await bot.stop();
    });

test('expired ambiguous POST with absent result remains explicitly unknown',
    async (t) => {
      const dir = await fixture(t);
      const request = record();
      const first = await openLedger({dir});
      await first.add(request);
      await first.update(request.request_id, {attempts: 1});
      await first.close();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        maxRequestAgeMs: 1, adapter: {
          write: async () => assert.fail('expired must not POST'),
          read: async () => null}});
      await bot.processPending();
      assert.equal(bot.snapshot().unknown, 1);
      assert.equal(bot.snapshot().failed, 0);
      await bot.stop();
    });

test('exclusive reopen cleans abandoned snapshot temporary files',
    async (t) => {
      const dir = await fixture(t);
      const stale = path.join(dir,
          '.ledger-21d10fd2-5b3c-4ab3-9c7f-c47ee6234e59.tmp');
      await fs.writeFile(stale, 'abandoned');
      const ledger = await openLedger({dir});
      await assert.rejects(fs.stat(stale),
          (error) => error.code === 'ENOENT');
      await ledger.close();
    });

test('paused pending capacity applies backpressure and resumes without loss',
    async (t) => {
      const dir = await fixture(t);
      const records = new Map();
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        maxPending: 1, ratePerSecond: 100, adapter: {
          write: async (request) => {
            records.set(request.request_id, request);
            return envelope(request);
          },
          read: async (id) =>
            records.has(id) ? envelope(records.get(id)) : null,
        }});
      await bot.pause();
      void bot.start();
      while (bot.snapshot().generation_blocked === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(bot.snapshot().pending, 1);
      assert.equal(bot.snapshot().fatal, null);
      bot.resume();
      while (bot.snapshot().committed < 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await bot.stop();
      assert.equal(bot.snapshot().fatal, null);
      const saved = JSON.parse(
          await fs.readFile(path.join(dir, 'ledger.json')));
      assert.equal(saved.entries.length,
          bot.snapshot().committed + bot.snapshot().pending);
      assert.equal(bot.snapshot().failed, 0);
    });

test('metrics labels sanitize unsupported controls and escape quotes/newlines',
    async (t) => {
      const dir = await fixture(t);
      let request;
      const response = () => ({...envelope(request),
        environment: 'local\tbad\n"\\\r'});
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        adapter: {
          write: async (value) => { request = value; return response(); },
          read: async () => response(),
        }});
      await bot.enqueue(record());
      await bot.processPending();
      const line = bot.metrics().split('\n').find((value) =>
        value.startsWith('traffic_bot_environment_commits_total{'));
      assert.equal(line, 'traffic_bot_environment_commits_total' +
          '{environment="local_bad\\n\\"\\\\_"} 1');
      assert.doesNotMatch(line, /[\t\r]/);
      await bot.stop();
    });

test('corrupt persisted scheduling state is rejected, never forever pending',
    async (t) => {
      const dir = await fixture(t);
      const ledger = await openLedger({dir});
      await ledger.add(record());
      await ledger.close();
      const file = path.join(dir, 'ledger.json');
      const original = JSON.parse(await fs.readFile(file));
      for (const value of [null, -1, 'tomorrow', 1.5, undefined]) {
        const corrupt = structuredClone(original);
        corrupt.entries[0].nextAttemptAt = value;
        await fs.writeFile(file, JSON.stringify(corrupt));
        await assert.rejects(openLedger({dir}), /invalid ledger entry/);
      }
    });

test('structured write pause can exceed attempt cap and resume the same request',
    async (t) => {
      const dir = await fixture(t);
      const request = record();
      const bodies = [];
      let paused = true;
      let stored;
      let reads = 0;
      const baseUrl = await serve(t, async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          reads++;
          if (!stored) { res.writeHead(404); return res.end('{}'); }
          return res.end(JSON.stringify(envelope(stored)));
        }
        const body = await readBody(req);
        bodies.push(JSON.parse(body));
        if (paused) {
          res.writeHead(503, {'Retry-After': '0'});
          return res.end(JSON.stringify({error: {code: 'WRITES_PAUSED'}}));
        }
        stored = JSON.parse(body);
        res.writeHead(201);
        res.end(JSON.stringify(envelope(stored)));
      });
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        maxAttempts: 2, retryDelayMs: 1,
        adapter: createHttpAdapter({baseUrl})});
      await bot.enqueue(request);
      for (let count = 0; count < 5; count++) {
        await bot.processPending();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(bodies.length, 5);
      assert.equal(reads, 0);
      assert.equal(bot.snapshot().pending, 1);
      assert.equal(bot.snapshot().unknown, 0);
      paused = false;
      await bot.processPending();
      assert.equal(bot.snapshot().committed, 1);
      assert.ok(bodies.every((body) =>
        JSON.stringify(body) === JSON.stringify(request)));
      await bot.stop();
    });

test('generic HTTP 503 remains ambiguous and consumes the attempt budget',
    async (t) => {
      const dir = await fixture(t);
      let writes = 0;
      const baseUrl = await serve(t, (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          res.writeHead(404);
          return res.end('{}');
        }
        writes++;
        res.writeHead(503);
        res.end(JSON.stringify({error: {code: 'DB_UNAVAILABLE',
          message: 'must not be persisted'}}));
      });
      const bot = await createTrafficBot({ledgerDir: dir, runId: RUN_ID,
        maxAttempts: 2, retryDelayMs: 1,
        adapter: createHttpAdapter({baseUrl})});
      await bot.enqueue(record());
      for (let count = 0; count < 3; count++) {
        await bot.processPending();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(writes, 2);
      assert.equal(bot.snapshot().unknown, 1);
      await bot.stop();
      assert.doesNotMatch(await fs.readFile(path.join(dir, 'ledger.json'),
          'utf8'), /must not be persisted/);
    });
