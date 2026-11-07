const {readLedger} = require('./bot-ledger-reader');
// Kernel flock ownership of the bot ledger. These tests need Linux (or a
// compatible flock(1)); run them in the pinned node:22 Linux image.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const {randomUUID} = require('node:crypto');
const {once} = require('node:events');
const {spawn, spawnSync} = require('node:child_process');
const {createTrafficBot, openLedger} = require('../packages/traffic-bot');

const PACKAGE = path.resolve(__dirname, '../packages/traffic-bot');
const OWNER = path.join(__dirname, 'fixtures/traffic-bot-owner.js');
const LOCK_FILE = '.owner.lock';
const OPEN_SCRIPT = `
const {openLedger} = require(process.argv[1]);
openLedger({dir: process.argv[2]}).then(async (ledger) => {
  await ledger.close();
  process.stdout.write(JSON.stringify({code: 'OPENED'}));
}, (error) => {
  process.stdout.write(JSON.stringify({code: error.code,
    message: error.message}));
});
`;

function record() {
  return {request_id: randomUUID(), run_id: 'lock_test', phase: 'onprem_live',
    request_no: '1', payload: 'test', created_at: new Date().toISOString()};
}
function envelope(request) {
  return {status: 'committed', request, environment: 'local',
    database: {name: 'migration_demo'}};
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-lock-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}
async function savedIds(dir) {
  const {entries} = JSON.parse(
      await readLedger(dir));
  return entries.map((entry) => entry.request.request_id);
}
/** Reads every regular file in dir so a test can prove nothing changed. */
async function snapshotFiles(dir) {
  const files = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    files[name] = await fs.readFile(path.join(dir, name), 'utf8');
  }
  return files;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

/** Starts the owner fixture and waits until it holds the ledger lock. */
async function startOwner(t, dir, mode = 'plain') {
  const child = spawn(process.execPath, [OWNER, dir, mode],
      {stdio: ['pipe', 'pipe', 'inherit']});
  const exited = once(child, 'exit');
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGCONT');
      child.kill('SIGKILL');
    }
  });
  const lines = readline.createInterface({input: child.stdout});
  const iterator = lines[Symbol.asyncIterator]();
  const next = async () => {
    const {value, done} = await iterator.next();
    if (done) throw new Error('owner fixture exited');
    return value;
  };
  const ready = await next();
  assert.match(ready, /^ready \d+$/);
  return {
    child, exited, descendantPid: Number(ready.split(' ')[1]),
    add: (request) => {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      return next();
    },
  };
}

/** Opens the ledger in a separate Node process with a controlled PATH. */
function openIsolated(dir, pathValue, cwd) {
  const result = spawnSync(process.execPath,
      ['-e', OPEN_SCRIPT, PACKAGE, dir],
      {env: {PATH: pathValue}, cwd, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('a live owner rejects a second process without touching its files',
    async (t) => {
      const dir = await fixture(t);
      const owner = await startOwner(t, dir);
      assert.equal(await owner.add(record()), 'added');
      const before = await snapshotFiles(dir);
      await assert.rejects(openLedger({dir}), {code: 'LEDGER_OWNED'});
      assert.deepEqual(await snapshotFiles(dir), before);
      const metadata = JSON.parse(before[LOCK_FILE]);
      assert.equal(metadata.pid, owner.child.pid);
      assert.equal(metadata.runId, 'owner_fixture');
      assert.equal(typeof metadata.hostname, 'string');
      assert.ok(Number.isFinite(Date.parse(metadata.startedAt)));
      const mode = (await fs.stat(path.join(dir, LOCK_FILE))).mode;
      assert.equal(mode & 0o777, 0o600);
    });

test('a stopped owner keeps the lock despite stale mtime and forged metadata',
    async (t) => {
      const dir = await fixture(t);
      const lockFile = path.join(dir, LOCK_FILE);
      const owner = await startOwner(t, dir);
      const first = record();
      assert.equal(await owner.add(first), 'added');
      owner.child.kill('SIGSTOP');
      const past = new Date(Date.now() - 24 * 3600 * 1000);
      await fs.writeFile(lockFile, JSON.stringify({pid: 999999,
        hostname: 'gone', startedAt: past.toISOString()}));
      await fs.utimes(lockFile, past, past);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await assert.rejects(openLedger({dir}), {code: 'LEDGER_OWNED'});
      owner.child.kill('SIGCONT');
      const second = record();
      assert.equal(await owner.add(second), 'added');
      assert.deepEqual(await savedIds(dir),
          [first.request_id, second.request_id]);
    });

test('SIGKILL releases the lock at once and the next bot finishes the work',
    async (t) => {
      const dir = await fixture(t);
      const owner = await startOwner(t, dir);
      const request = record();
      assert.equal(await owner.add(request), 'added');
      owner.child.kill('SIGKILL');
      await owner.exited;
      const bot = await createTrafficBot({ledgerDir: dir, runId: 'run_b',
        adapter: {write: async (value) => envelope(value),
          read: async () => envelope(request)}});
      await bot.processPending();
      assert.equal(bot.snapshot().committed, 1);
      await bot.stop();
      assert.deepEqual(await savedIds(dir), [request.request_id]);
    });

test('SIGTERM closes the ledger and the lock is reacquired immediately',
    async (t) => {
      const dir = await fixture(t);
      const owner = await startOwner(t, dir);
      owner.child.kill('SIGTERM');
      const [code] = await owner.exited;
      assert.equal(code, 0);
      const ledger = await openLedger({dir});
      await ledger.close();
    });

test('a descendant spawned without the descriptor does not keep the lock',
    async (t) => {
      const dir = await fixture(t);
      const owner = await startOwner(t, dir, 'descendant');
      const pid = owner.descendantPid;
      assert.ok(pid > 0);
      t.after(() => {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      });
      owner.child.kill('SIGKILL');
      await owner.exited;
      assert.ok(alive(pid), 'descendant must outlive the owner');
      const ledger = await openLedger({dir});
      await ledger.close();
    });

test('replacing or removing the lock file fails the next persist as LOST',
    async (t) => {
      const changes = {
        replaced: async (lockFile) => {
          const other = `${lockFile}.new`;
          await fs.writeFile(other, '{}');
          await fs.rename(other, lockFile);
        },
        removed: (lockFile) => fs.unlink(lockFile),
      };
      for (const [name, change] of Object.entries(changes)) {
        await t.test(name, async (t) => {
          const dir = await fixture(t);
          const ledger = await openLedger({dir});
          await ledger.add(record());
          const before = await readLedger(dir);
          await change(path.join(dir, LOCK_FILE));
          await assert.rejects(ledger.add(record()),
              {code: 'LEDGER_LOCK_LOST'});
          assert.deepEqual(await readLedger(dir),
              before);
          assert.deepEqual((await fs.readdir(dir)).filter((file) =>
            file.endsWith('.tmp')), []);
          await ledger.close();
        });
      }
    });

test('a symlinked lock path is refused before any ledger write', async (t) => {
  const dir = await fixture(t);
  const outside = await fixture(t);
  const target = path.join(outside, 'target');
  await fs.writeFile(target, 'keep');
  await fs.symlink(target, path.join(dir, LOCK_FILE));
  await assert.rejects(openLedger({dir}), {code: 'LEDGER_LOCK_UNSUPPORTED'});
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
  await assert.rejects(fs.stat(path.join(dir, 'ledger.json')),
      {code: 'ENOENT'});
});

test('a non-regular lock path is refused', async (t) => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, LOCK_FILE));
  await assert.rejects(openLedger({dir}), {code: 'LEDGER_LOCK_UNSUPPORTED'});
});

test('a missing flock helper is refused with a message free of paths',
    async (t) => {
      const empty = await fixture(t);
      for (const pathValue of ['', empty]) {
        const dir = await fixture(t);
        const result = openIsolated(dir, pathValue, empty);
        assert.equal(result.code, 'LEDGER_LOCK_UNSUPPORTED');
        assert.ok(!result.message.includes(dir));
        await assert.rejects(fs.stat(path.join(dir, 'ledger.json')),
            {code: 'ENOENT'});
      }
    });

test('a helper that reports success without locking is refused; owner kept',
    async (t) => {
      const dir = await fixture(t);
      const owner = await startOwner(t, dir);
      assert.equal(await owner.add(record()), 'added');
      await fs.writeFile(path.join(dir, `.ledger-${randomUUID()}.tmp`),
          'owner temporary file');
      const before = await snapshotFiles(dir);
      const bin = await fixture(t);
      await fs.writeFile(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n',
          {mode: 0o755});
      const result = openIsolated(dir, bin, bin);
      assert.equal(result.code, 'LEDGER_LOCK_UNSUPPORTED');
      assert.deepEqual(await snapshotFiles(dir), before);
      assert.equal(await owner.add(record()), 'added');
    });

test('a legacy lease directory blocks start until an operator retires it',
    async (t) => {
      const dir = await fixture(t);
      const ledger = await openLedger({dir});
      await ledger.add(record());
      await ledger.close();
      const legacy = `${await fs.realpath(dir)}.lock`;
      await fs.mkdir(legacy);
      t.after(() => fs.rm(legacy, {recursive: true, force: true}));
      const before = await snapshotFiles(dir);
      await assert.rejects(openLedger({dir}), {code: 'LEDGER_LEGACY_LOCK'});
      assert.ok((await fs.lstat(legacy)).isDirectory());
      assert.deepEqual(await snapshotFiles(dir), before);
      // Upgrade only: after the old writer is confirmed gone, an operator
      // removes the empty lease directory and the new protocol takes over.
      await fs.rmdir(legacy);
      const reopened = await openLedger({dir});
      assert.equal(reopened.entries().length, 1);
      await reopened.close();
    });

test('close drains queued writes before releasing the lock', async (t) => {
  const dir = await fixture(t);
  const ledger = await openLedger({dir});
  const request = record();
  const added = ledger.add(request);
  await ledger.close();
  await added;
  const reopened = await openLedger({dir});
  assert.deepEqual(reopened.entries().map((entry) =>
    entry.request.request_id), [request.request_id]);
  await reopened.close();
});
