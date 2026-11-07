const fs = require('node:fs/promises');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
async function readLedger(dir) {
  const file = path.join(dir, 'ledger.sqlite');
  const exists = await fs.stat(file).catch(() => null);
  if (!exists) return fs.readFile(path.join(dir, 'ledger.json'), 'utf8');
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const entries = db.prepare('SELECT body FROM entries ORDER BY rowid').all().map(r => JSON.parse(r.body));
    return JSON.stringify({version: 1, entries});
  } finally { db.close(); }
}
module.exports = {readLedger};
