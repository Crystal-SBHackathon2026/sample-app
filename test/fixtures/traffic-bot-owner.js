// Owns a ledger in its own process so tests can stop, kill or race it.
// Usage: node traffic-bot-owner.js <ledgerDir> [plain|descendant]
// stdout: "ready <descendantPid>", then one "added"/"error <code>" per line
// of JSON requests read from stdin. SIGTERM closes the ledger and exits 0.
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {openLedger} = require('../../packages/traffic-bot');

async function main([dir, mode = 'plain']) {
  const ledger = await openLedger({dir, runId: 'owner_fixture'});
  let descendantPid = 0;
  if (mode === 'descendant') {
    // Spawned without the lock descriptor; it must not keep the lock alive.
    const descendant = spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000);'],
        {stdio: 'ignore', detached: true});
    descendant.unref();
    descendantPid = descendant.pid;
  }
  process.once('SIGTERM', async () => {
    await ledger.close();
    process.exit(0);
  });
  readline.createInterface({input: process.stdin}).on('line', async (line) => {
    try {
      await ledger.add(JSON.parse(line));
      process.stdout.write('added\n');
    } catch (error) {
      process.stdout.write(`error ${error.code || 'UNKNOWN'}\n`);
    }
  });
  process.stdout.write(`ready ${descendantPid}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stdout.write(`error ${error.code || 'UNKNOWN'}\n`);
  process.exit(1);
});
