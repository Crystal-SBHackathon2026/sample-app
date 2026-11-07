const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {DatabaseSync} = require('node:sqlite');
const {openLedger} = require('../packages/traffic-bot/ledger');
const request = id => ({request_id: id, run_id: 'storage', request_no: id,
  payload: 'evidence', phase: 'test', created_at: new Date().toISOString()});
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-storage-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}
test('legacy import preserves evidence, imports once, and updates only one row', async t => {
  const dir = await fixture(t);
  const entries = Array.from({length: 20000}, (_, i) => ({request: request(String(i)),
    state: 'committed', attempts: 1, enqueuedAt: 1, nextAttemptAt: 0, observations: []}));
  const legacy = JSON.stringify({version: 1, entries});
  await fs.writeFile(path.join(dir, 'ledger.json'), legacy);
  const config = {dir, maxRecords: 30000, maxLedgerBytes: 32 * 1024 * 1024};
  let ledger = await openLedger(config);
  await ledger.add(request('new'));
  await ledger.update('new', {attempts: 1, state: 'committed'});
  assert.equal(ledger.summary().committed, 20001);
  assert.equal(ledger.pendingEntries().length, 0);
  await ledger.close();
  assert.equal(await fs.readFile(path.join(dir, 'ledger.v1.backup.json'), 'utf8'), legacy);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'ledger.json'))).version, 2);
  ledger = await openLedger(config);
  assert.equal(ledger.summary().committed, 20001);
  assert.deepEqual(ledger.entries().slice(0, 20000), entries);
  await ledger.close();
});
test('failed SQLite transaction leaves persisted and in-memory state unchanged', async t => {
  const dir = await fixture(t);
  let ledger = await openLedger({dir});
  await ledger.add(request('1'));
  const db = new DatabaseSync(path.join(dir, 'ledger.sqlite'));
  db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END");
  await assert.rejects(ledger.update('1', {state: 'committed'}), /simulated disk failure/);
  assert.equal(ledger.summary().pending, 1);
  assert.equal(ledger.summary().committed, 0);
  db.close();
  await ledger.close();
  ledger = await openLedger({dir});
  assert.equal(ledger.pendingEntries()[0].state, 'pending');
  await ledger.close();
});
test('missing converted database fails closed instead of replaying stale backup', async t => {
  const dir = await fixture(t);
  const ledger = await openLedger({dir});
  await ledger.add(request('1'));
  await ledger.close();
  await fs.rm(path.join(dir, 'ledger.sqlite'));
  await assert.rejects(openLedger({dir}), /unsupported or corrupt ledger/);
});
