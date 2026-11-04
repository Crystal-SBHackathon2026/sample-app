const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {
  createTrafficBot, createHttpAdapter, openLedger,
} = require('../packages/traffic-bot');

function envelope(request) {
  return {status: 'committed', request, environment: 'test',
    database: {name: 'test'}};
}

function reply(status, body = {}) {
  return new Response(JSON.stringify(body), {status});
}

/** Real ledger I/O and product adapter; only HTTP transport is replaced. */
async function fixture(t, respond, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-retry-'));
  let now = 1793793600000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url, init) =>
    respond(init.method, init.body && JSON.parse(init.body)));
  const request = {request_id: randomUUID(), run_id: 'retry-test',
    phase: 'test', request_no: '1', payload: 'original',
    created_at: '2026-11-04T12:00:00.000Z'};
  const config = {ledgerDir: dir, runId: request.run_id, retryDelayMs: 1,
    maxRequestAgeMs: 10000, maxAttempts: 3,
    adapter: createHttpAdapter({baseUrl: 'https://test.invalid'}), ...options};
  let bot;
  t.after(async () => {
    if (bot) await bot.stop();
    await fs.rm(dir, {recursive: true, force: true});
  });
  bot = await createTrafficBot(config);
  await bot.enqueue(request);
  return {
    get bot() { return bot; }, request, dir,
    advance(ms = 10) { now += ms; },
    async entry() {
      const data = JSON.parse(await fs.readFile(path.join(dir, 'ledger.json')));
      return data.entries[0];
    },
    async reopen() {
      await bot.stop();
      bot = await createTrafficBot(config);
    },
  };
}

test('prior uncertain POST survives later refusals and recovers late COMMIT',
    async (t) => {
      for (const status of [400, 401, 403, 409]) {
        await t.test(`retry POST ${status}`, async (t) => {
          let writes = 0;
          let stored;
          let visible = false;
          const retry = await fixture(t, (method, request) => {
            if (method === 'GET') {
              return visible ? reply(200, envelope(stored)) : reply(404);
            }
            writes++;
            if (writes === 1) {
              stored = request;
              throw new Error('response lost while COMMIT waits');
            }
            return reply(status);
          });
          await retry.bot.processPending();
          retry.advance();
          await retry.bot.processPending();
          assert.equal(retry.bot.snapshot().failed, 0);
          assert.equal((await retry.entry()).state, 'pending');
          assert.equal((await retry.entry()).attempts, 2);
          assert.equal((await retry.entry()).lastError, `HTTP_${status}`);
          visible = true;
          retry.advance();
          await retry.reopen();
          await retry.bot.processPending();
          assert.equal(retry.bot.snapshot().committed, 1);
          assert.equal(writes, 2);
          assert.deepEqual((await retry.entry()).request, retry.request);
        });
      }
    });

test('first POST refusal proves failure without GET, including after pause',
    async (t) => {
      for (const [status, pauseFirst] of [
        [400, false], [409, false], [400, true], [409, true],
      ]) {
        await t.test(`first POST ${status}, pause ${pauseFirst}`, async (t) => {
          let paused = pauseFirst;
          const retry = await fixture(t, (method) => {
            assert.equal(method, 'POST');
            return paused ? reply(503, {error: {code: 'WRITES_PAUSED'}}) :
              reply(status);
          });
          if (pauseFirst) {
            await retry.bot.processPending();
            assert.equal((await retry.entry()).attempts, 0);
            paused = false;
            retry.advance();
          }
          await retry.bot.processPending();
          assert.equal((await retry.entry()).state, 'failed');
          assert.equal((await retry.entry()).attempts, 1);
          assert.equal((await retry.entry()).lastError, `HTTP_${status}`);
        });
      }
    });

test('recovery GET 401 cannot settle an uncertain POST; age ends unknown',
    async (t) => {
      let writes = 0;
      const retry = await fixture(t, (method, request) => {
        if (method === 'GET') return reply(401);
        writes++;
        return reply(201, envelope(request));
      });
      await retry.bot.processPending();
      retry.advance();
      await retry.reopen();
      await retry.bot.processPending();
      assert.equal((await retry.entry()).state, 'pending');
      assert.equal((await retry.entry()).attempts, 1);
      retry.advance(10000);
      await retry.bot.processPending();
      assert.equal((await retry.entry()).state, 'unknown');
      assert.equal(writes, 1);
    });

test('later POST refusals stop at attempt cap after final GET', async (t) => {
  let writes = 0;
  let reads = 0;
  const retry = await fixture(t, (method) => {
    if (method === 'GET') {
      reads++;
      return reply(404);
    }
    if (++writes === 1) throw new Error('uncertain');
    return reply(403);
  });
  for (let i = 0; i < 6; i++) {
    await retry.bot.processPending();
    retry.advance();
  }
  assert.equal((await retry.entry()).state, 'unknown');
  assert.equal((await retry.entry()).attempts, 3);
  assert.equal(writes, 3);
  assert.ok(reads >= 4);
});

test('late refusal still allows GET content conflict to prove failure',
    async (t) => {
      let writes = 0;
      let stored;
      const retry = await fixture(t, (method, request) => {
        if (method === 'GET') {
          return writes < 2 ? reply(404) :
            reply(200, envelope({...stored, payload: 'different'}));
        }
        if (++writes === 1) {
          stored = request;
          throw new Error('uncertain');
        }
        return reply(409);
      });
      await retry.bot.processPending();
      retry.advance();
      await retry.bot.processPending();
      assert.equal((await retry.entry()).state, 'failed');
      assert.equal((await retry.entry()).lastError, 'CONTENT_CONFLICT');
    });

test('pause refunds only its POST and preserves earlier uncertainty',
    async (t) => {
      let writes = 0;
      const retry = await fixture(t, (method) => {
        if (method === 'GET') return reply(404);
        if (++writes === 1) throw new Error('uncertain');
        return reply(503, {error: {code: 'WRITES_PAUSED'}});
      });
      for (let i = 0; i < 4; i++) {
        await retry.bot.processPending();
        retry.advance();
      }
      assert.equal((await retry.entry()).attempts, 1);
      assert.equal((await retry.entry()).state, 'pending');
      retry.advance(10000);
      await retry.bot.processPending();
      assert.equal((await retry.entry()).state, 'unknown');
      assert.equal(writes, 4);
    });

test('invalid 2xx and final GET retain committed, conflict and unknown rules',
    async (t) => {
      for (const [outcome, age] of [
        ['committed', 10000], ['failed', 10000], ['unknown', 10000],
        ['committed', 1], ['failed', 1], ['unknown', 1],
      ]) {
        await t.test(`${outcome}, age ${age}`, async (t) => {
          let stored;
          let reads = 0;
          let writes = 0;
          const retry = await fixture(t, (method, request) => {
            if (method === 'POST') {
              writes++;
              stored = request;
              return new Response('not JSON', {status: 201});
            }
            if (++reads === 1 || outcome === 'unknown') return reply(404);
            return reply(200, envelope(outcome === 'failed' ?
              {...stored, payload: 'different'} : stored));
          }, {maxAttempts: 1, maxRequestAgeMs: age});
          await retry.bot.processPending();
          assert.equal((await retry.entry()).state, 'pending');
          retry.advance();
          await retry.bot.processPending();
          assert.equal((await retry.entry()).state, outcome);
          assert.equal(writes, 1);
          assert.equal(reads, 2);
        });
      }
    });

test('SDK retryAfterMs always persists a safe schedule that reopens',
    async (t) => {
      const now = 1793793600000;
      const cases = [
        [1000.5, 1001], [0.5, 1000], [0, 1000], [NaN, 1000],
        [Infinity, 1000], [-Infinity, 1000], [-1, 1000],
        [Number.MAX_VALUE, 10000], [Number.MAX_SAFE_INTEGER, 10000],
        ['1001', 1000], [null, 1000], [undefined, 1000],
        [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER - now,
          Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ];
      for (const [value, expected, age = 10000, retryDelayMs = 1000] of cases) {
        await t.test(`${String(value)} / age ${age}`, async (t) => {
          const retry = await fixture(t, () => {}, {maxRequestAgeMs: age,
            retryDelayMs, adapter: {
              write: async () => {
                throw Object.assign(new Error('retry'), {retryAfterMs: value});
              },
              read: async () => null,
            }});
          await retry.bot.processPending();
          const entry = await retry.entry();
          assert.ok(Number.isSafeInteger(entry.nextAttemptAt));
          assert.equal(entry.nextAttemptAt - now, expected);
          assert.ok(entry.nextAttemptAt - now <= age);
          await retry.bot.stop();
          const ledger = await openLedger({dir: retry.dir});
          assert.equal(ledger.entries()[0].nextAttemptAt, entry.nextAttemptAt);
          await ledger.close();
        });
      }
    });

test('HTTP Retry-After parser returns safe nonnegative milliseconds',
    async (t) => {
      const now = 1793793600000;
      t.mock.method(Date, 'now', () => now);
      let value;
      t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
        status: 429, headers: value === null ? {} : {'Retry-After': value},
      }));
      const adapter = createHttpAdapter({baseUrl: 'https://test.invalid'});
      const cases = [
        [null, 0], ['', 0], ['0', 0], ['1.0005', 1001], ['-1', 0],
        ['NaN', 0], ['Infinity', 0], ['-Infinity', 0], ['invalid', 0],
        ['1e300', Number.MAX_SAFE_INTEGER], ['1e309', 0],
        [new Date(now + 5000).toUTCString(), 5000],
        [new Date(now - 5000).toUTCString(), 0],
      ];
      for (const [header, expected] of cases) {
        value = header;
        await assert.rejects(adapter.write({}), (error) => {
          assert.ok(Number.isSafeInteger(error.retryAfterMs), String(header));
          assert.equal(error.retryAfterMs, expected, String(header));
          return error.status === 429;
        });
      }
    });
