const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {randomUUID} = require('node:crypto');
const {createTrafficBot} = require('../packages/traffic-bot');

test('accepted requests survive retry expiry and restart, without duplicate POST', async (t) => {
  const ledgerDir = await mkdtemp(join(tmpdir(), 'accepted-'));
  let bot; let posts = 0; let committed = false; let now = Date.now();
  const request = {request_id: randomUUID(), run_id: 'async', phase: 'test',
    request_no: '1', payload: 'one', created_at: new Date().toISOString()};
  t.mock.method(Date, 'now', () => now);
  const response = () => committed ? {status: 'committed', request,
    database: {name: 'target'}, environment: 'aws'} : {status: 'accepted', request};
  const config = {ledgerDir, runId: 'async', retryDelayMs: 1, maxRequestAgeMs: 10,
    adapter: {write: async () => { posts++; return response(); }, read: async () => response()}};
  t.after(async () => { await bot?.stop(); await rm(ledgerDir, {recursive: true, force: true}); });
  bot = await createTrafficBot(config); await bot.enqueue(request); await bot.processPending();
  assert.equal(bot.snapshot().accepted_pending, 1);
  assert.equal(bot.snapshot().committed, 0);
  await bot.stop(); bot = await createTrafficBot(config); now += 310000;
  await bot.processPending();
  assert.equal(bot.snapshot().pending, 1); assert.equal(bot.snapshot().failed, 0);
  assert.equal(bot.snapshot().unknown, 0); assert.equal(posts, 1);
  committed = true; now += 10; await bot.processPending();
  assert.equal(bot.snapshot().committed, 1); assert.equal(posts, 1);
});
