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

function record() {
  return {request_id: randomUUID(), run_id: 'test', phase: 'onprem_live',
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

test('ledger persists requests before send and resumes pending after reopen',
    async (t) => {
      const dir = await fixture(t);
      const request = record();
      const first = await openLedger({dir});
      await first.add(request);
      await first.close();
      const bot = await createTrafficBot({ledgerDir: dir, adapter: {
        write: async (value) => envelope(value),
        read: async () => envelope(request),
      }});
      await bot.processPending();
      assert.equal(bot.snapshot().committed, 1);
      await bot.stop();
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'ledger.json')));
      assert.deepEqual(saved.entries[0].request, request);
      assert.equal(saved.entries[0].state, 'committed');
      assert.equal(saved.entries[0].observations[0].environment, 'local');
    });

test('lost write response is reconciled through GET with the same ID',
    async (t) => {
      const dir = await fixture(t);
      let stored;
      let writes = 0;
      const bot = await createTrafficBot({ledgerDir: dir, retryDelayMs: 1,
        adapter: {
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
      assert.match(bot.metrics(), /traffic_bot_requests_total\{state="committed"\} 1/);
      await bot.stop();
    });

test('retry uses immutable body and malformed response is terminal', async (t) => {
  const dir = await fixture(t);
  const sent = [];
  const bot = await createTrafficBot({ledgerDir: dir, retryDelayMs: 1,
    adapter: {
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
  assert.equal(bot.snapshot().failed, 1);
  await bot.stop();
});

test('single writer lock and bounded pending queue reject extra work', async (t) => {
  const dir = await fixture(t);
  const ledger = await openLedger({dir, maxPending: 1});
  await assert.rejects(openLedger({dir}),
      (error) => error.code === 'ELOCKED');
  await ledger.add(record());
  await assert.rejects(ledger.add(record()), /limit/);
  await ledger.close();
});

test('HTTP adapter writes and reads contract; permanent 409 is explicit',
    async (t) => {
      const request = record();
      let conflict = false;
      const server = createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (conflict) {
          res.writeHead(409);
          return res.end(JSON.stringify({error: {code: 'REQUEST_CONFLICT'}}));
        }
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          assert.deepEqual(JSON.parse(body), request);
          res.writeHead(201);
        }
        res.end(JSON.stringify(envelope(request)));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => server.close());
      const adapter = createHttpAdapter({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
      assert.equal((await adapter.write(request)).request.request_id,
          request.request_id);
      assert.equal((await adapter.read(request.request_id)).request.payload,
          request.payload);
      conflict = true;
      await assert.rejects(adapter.write(request), (error) => error.terminal);
    });

test('attempt cap still reconciles an ambiguous final attempt before failure',
    async (t) => {
      const dir = await fixture(t);
      let writes = 0;
      let readable = false;
      let stored;
      const bot = await createTrafficBot({ledgerDir: dir, maxAttempts: 1,
        retryDelayMs: 1, adapter: {
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
      const bot = await createTrafficBot({ledgerDir: dir,
        maxRequestAgeMs: 1, adapter: {
          write: async () => { writes++; }, read: async () => null,
        }});
      await new Promise((resolve) => setTimeout(resolve, 5));
      await bot.processPending();
      assert.equal(bot.snapshot().failed, 1);
      assert.equal(writes, 0);
      await bot.stop();
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'ledger.json')));
      assert.equal(saved.entries[0].lastError, 'REQUEST_EXPIRED');
    });

test('stop promptly wakes a low-rate runner and preserves in-flight requests',
    async (t) => {
      const dir = await fixture(t);
      let stored;
      const bot = await createTrafficBot({ledgerDir: dir, ratePerSecond: 0.001,
        adapter: {
          write: async (request) => { stored = request; return envelope(request); },
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

test('CLI numeric environment values reject blank, NaN, fractional counts', () => {
  const {numeric} = require('../packages/traffic-bot/bin/traffic-bot');
  for (const value of ['', 'NaN', '-1', 'Infinity', '1.5']) {
    assert.throws(() => numeric({BOT_MAX_PENDING: value},
        'BOT_MAX_PENDING', 10));
  }
});

test('SIGKILL leaves durable pending work and stale lease recovers safely',
    {timeout: 20000}, async (t) => {
      const {spawn} = require('node:child_process');
      const dir = await fixture(t);
      const request = record();
      const modulePath = path.resolve(__dirname, '../packages/traffic-bot');
      const child = spawn(process.execPath, ['-e', `
        const {openLedger} = require(${JSON.stringify(modulePath)});
        (async () => {
          const ledger = await openLedger({dir: process.argv[1]});
          await ledger.add(JSON.parse(process.argv[2]));
          console.log('ready');
          setInterval(() => {}, 1000);
        })().catch(() => process.exit(1));
      `, dir, JSON.stringify(request)], {stdio: ['ignore', 'pipe', 'pipe']});
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`early child exit ${code}`)));
        child.stdout.once('data', resolve);
      });
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      const bot = await createTrafficBot({ledgerDir: dir,
        lockRetries: {retries: 15, minTimeout: 1000, maxTimeout: 1000},
        adapter: {write: async (value) => envelope(value),
          read: async () => envelope(request)}});
      await bot.processPending();
      assert.equal(bot.snapshot().committed, 1);
      await bot.stop();
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
      const bot = await createTrafficBot({ledgerDir: dir, maxRequestAgeMs: 1,
        adapter: {write: async () => assert.fail('expired must not POST'),
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
      const bot = await createTrafficBot({ledgerDir: dir, maxRequestAgeMs: 1,
        adapter: {write: async () => assert.fail('expired must not POST'),
          read: async () => null}});
      await bot.processPending();
      assert.equal(bot.snapshot().unknown, 1);
      assert.equal(bot.snapshot().failed, 0);
      await bot.stop();
    });

test('exclusive reopen cleans abandoned snapshot temporary files', async (t) => {
  const dir = await fixture(t);
  const stale = path.join(dir,
      '.ledger-21d10fd2-5b3c-4ab3-9c7f-c47ee6234e59.tmp');
  await fs.writeFile(stale, 'abandoned');
  const ledger = await openLedger({dir});
  await assert.rejects(fs.stat(stale), (error) => error.code === 'ENOENT');
  await ledger.close();
});

test('paused pending capacity applies backpressure and resumes without loss',
    async (t) => {
      const dir = await fixture(t);
      const records = new Map();
      const bot = await createTrafficBot({ledgerDir: dir, maxPending: 1,
        ratePerSecond: 100, adapter: {
          write: async (request) => {
            records.set(request.request_id, request);
            return envelope(request);
          },
          read: async (id) => records.has(id) ? envelope(records.get(id)) : null,
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
      const saved = JSON.parse(await fs.readFile(path.join(dir, 'ledger.json')));
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
      const bot = await createTrafficBot({ledgerDir: dir, adapter: {
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
      const server = createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          reads++;
          if (!stored) { res.writeHead(404); return res.end('{}'); }
          return res.end(JSON.stringify(envelope(stored)));
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        bodies.push(JSON.parse(body));
        if (paused) {
          res.writeHead(503, {'Retry-After': '0'});
          return res.end(JSON.stringify({error: {code: 'WRITES_PAUSED'}}));
        }
        stored = JSON.parse(body);
        res.writeHead(201);
        res.end(JSON.stringify(envelope(stored)));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => server.close());
      const bot = await createTrafficBot({ledgerDir: dir, maxAttempts: 2,
        retryDelayMs: 1, adapter: createHttpAdapter({
          baseUrl: `http://127.0.0.1:${server.address().port}`,
        })});
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
      const server = createServer((req, res) => {
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
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => server.close());
      const bot = await createTrafficBot({ledgerDir: dir, maxAttempts: 2,
        retryDelayMs: 1, adapter: createHttpAdapter({
          baseUrl: `http://127.0.0.1:${server.address().port}`,
        })});
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
