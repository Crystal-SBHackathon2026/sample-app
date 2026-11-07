const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {openLedger} = require('../packages/traffic-bot/ledger');

function request() {
  return {request_id: randomUUID(), run_id: 'views', phase: 'test',
    request_no: '1', payload: 'original', created_at: new Date().toISOString()};
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-views-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('read views track durable outcomes and recover exactly after reopen', async (t) => {
  const dir = await fixture(t);
  let ledger = await openLedger({dir});
  t.after(() => ledger.close());
  const requests = Array.from({length: 4}, request);
  for (const req of requests) await ledger.add(req);
  await ledger.update(requests[0].request_id, {acceptedAt: 10});
  assert.equal(ledger.summary().accepted_pending, 1);
  await ledger.update(requests[1].request_id, {state: 'committed'});
  await ledger.update(requests[2].request_id, {state: 'failed'});
  await ledger.update(requests[3].request_id, {state: 'unknown'});
  const expected = {pending: 1, accepted_pending: 1, committed: 1,
    failed: 1, unknown: 1};
  assert.deepEqual(ledger.summary(), expected);
  const pending = ledger.pendingEntries();
  pending[0].request.payload = 'tampered';
  ledger.summary().pending = 100;
  assert.equal(ledger.pendingEntries()[0].request.payload, 'original');
  assert.deepEqual(ledger.summary(), expected);
  await ledger.close();
  ledger = await openLedger({dir});
  assert.deepEqual(ledger.summary(), expected);
  await ledger.update(requests[0].request_id, {state: 'committed'});
  assert.equal(ledger.summary().accepted_pending, 0);
  assert.deepEqual(ledger.pendingEntries(), []);
});

test('a failed persistence does not publish tentative counts or pending data', async (t) => {
  const dir = await fixture(t);
  const ledger = await openLedger({dir, maxLedgerBytes: 500});
  t.after(() => ledger.close());
  const req = request();
  await ledger.add(req);
  const before = ledger.summary();
  await assert.rejects(ledger.update(req.request_id, {
    state: 'committed', observations: ['x'.repeat(1000)],
  }), /size limit/);
  assert.deepEqual(ledger.summary(), before);
  assert.equal(ledger.pendingEntries()[0].state, 'pending');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'ledger.json')));
  assert.equal(saved.entries[0].state, 'pending');
});
