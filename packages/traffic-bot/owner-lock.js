const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {constants} = require('node:fs');
const {spawn} = require('node:child_process');

/**
 * Lock failures an operator may see. Messages carry no paths or secrets.
 * @const {!ReadonlyArray<string>}
 */
const LOCK_ERROR_CODES = Object.freeze([
  'LEDGER_OWNED',
  'LEDGER_LOCK_UNSUPPORTED',
  'LEDGER_LOCK_LOST',
  'LEDGER_LEGACY_LOCK',
]);

const LOCK_FILE_NAME = '.owner.lock';
const OPEN_FLAGS = constants.O_RDWR | constants.O_NOFOLLOW;
const HELPER_TIMEOUT_MS = 5000;
const FLOCK_HELD = 0;
const FLOCK_CONFLICT = 1;
const MESSAGES = Object.freeze({
  LEDGER_OWNED: 'ledger is owned by another live process',
  LEDGER_LOCK_UNSUPPORTED: 'safe kernel flock ownership is unavailable',
  LEDGER_LOCK_LOST: 'ledger owner lock file was replaced or removed',
  LEDGER_LEGACY_LOCK: 'a legacy ledger lease must be retired first',
});

/**
 * Creates an error whose code is one of LOCK_ERROR_CODES.
 * @param {string} code
 * @return {!Error}
 */
function lockError(code) {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  return error;
}

/**
 * Runs `flock -n -x 3` once against an open descriptor.
 * @param {number} fd
 * @return {!Promise<?number>} Exit status, or null if the helper failed.
 */
function runFlockHelper(fd) {
  return new Promise((resolve) => {
    const helper = spawn('flock', ['-n', '-x', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      timeout: HELPER_TIMEOUT_MS,
    });
    helper.once('error', () => resolve(null));
    helper.once('exit', (code) => resolve(code));
  });
}

/**
 * Refuses to start while a proper-lockfile lease directory remains.
 * @param {string} dir
 * @return {!Promise<void>}
 */
async function rejectLegacyLease(dir) {
  // The retired lease lived beside the real ledger path as `<dir>.lock`.
  const legacy = `${await fs.realpath(dir)}.lock`;
  try {
    await fs.lstat(legacy);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw lockError('LEDGER_LOCK_UNSUPPORTED');
  }
  throw lockError('LEDGER_LEGACY_LOCK');
}

/**
 * Opens a regular file without following symlinks.
 * @param {string} file
 * @param {number} flags
 * @return {!Promise<!fs.FileHandle>}
 */
async function openRegularFile(file, flags) {
  let handle;
  try {
    handle = await fs.open(file, flags, 0o600);
  } catch (error) {
    throw lockError('LEDGER_LOCK_UNSUPPORTED');
  }
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw lockError('LEDGER_LOCK_UNSUPPORTED');
  }
  return handle;
}

/**
 * Proves the helper left a real kernel lock on the held descriptor.
 * @param {string} file
 * @param {!fs.FileHandle} held
 * @return {!Promise<void>}
 */
async function verifyExclusive(file, held) {
  // A helper that exits 0 without locking would admit two writers.
  const probe = await openRegularFile(file, OPEN_FLAGS);
  try {
    const [heldStat, probeStat] = await Promise.all([held.stat(),
      probe.stat()]);
    if (heldStat.dev !== probeStat.dev || heldStat.ino !== probeStat.ino ||
        await runFlockHelper(probe.fd) !== FLOCK_CONFLICT) {
      throw lockError('LEDGER_LOCK_UNSUPPORTED');
    }
  } finally {
    await probe.close();
  }
}

/**
 * Replaces the lock file contents with diagnostics. Never used to decide.
 * @param {!fs.FileHandle} handle
 * @param {?string} runId
 * @return {!Promise<void>}
 */
async function writeDiagnostics(handle, runId) {
  const text = JSON.stringify({pid: process.pid, hostname: os.hostname(),
    runId, startedAt: new Date().toISOString()});
  await handle.truncate(0);
  await handle.write(`${text}\n`, 0);
  await handle.sync();
}

/**
 * Takes the single-writer kernel flock on `<dir>/.owner.lock`.
 *
 * The lock lives on a descriptor this process keeps open, so it survives
 * SIGSTOP and is released by the kernel on crash. The lock file is never
 * unlinked or renamed; ownership is never inferred from PID, host or time.
 *
 * @param {string} dir Existing ledger directory.
 * @param {{runId: (?string|undefined)}=} options Diagnostic run ID.
 * @return {!Promise<{assertHeld: function(): !Promise<void>,
 *     release: function(): !Promise<void>}>}
 */
async function acquireOwnerLock(dir, {runId = null} = {}) {
  await rejectLegacyLease(dir);
  const file = path.join(dir, LOCK_FILE_NAME);
  const handle = await openRegularFile(file, OPEN_FLAGS | constants.O_CREAT);
  try {
    const status = await runFlockHelper(handle.fd);
    if (status === FLOCK_CONFLICT) throw lockError('LEDGER_OWNED');
    if (status !== FLOCK_HELD) throw lockError('LEDGER_LOCK_UNSUPPORTED');
    await verifyExclusive(file, handle);
    await writeDiagnostics(handle, runId);
  } catch (error) {
    await handle.close();
    throw error;
  }
  let released = false;
  return {
    async assertHeld() {
      if (released) throw lockError('LEDGER_LOCK_LOST');
      const [held, current] = await Promise.all([handle.stat(),
        fs.lstat(file).catch(() => null)]);
      if (!current || current.dev !== held.dev || current.ino !== held.ino) {
        throw lockError('LEDGER_LOCK_LOST');
      }
    },
    async release() {
      if (released) return;
      released = true;
      await handle.close();
    },
  };
}

module.exports = {acquireOwnerLock, LOCK_ERROR_CODES};
