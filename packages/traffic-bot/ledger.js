const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const lockfile = require('proper-lockfile');

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** Open one durable, bounded journal. One process may own a directory. */
async function openLedger({dir, maxPending = 1000, maxRecords = 100000,
  maxLedgerBytes = 64 * 1024 * 1024, lockRetries = 0} = {}) {
  if (typeof dir !== 'string' || !dir) {
    throw new TypeError('ledger dir is required');
  }
  positiveInteger(maxPending, 'maxPending');
  positiveInteger(maxRecords, 'maxRecords');
  positiveInteger(maxLedgerBytes, 'maxLedgerBytes');
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  let compromised;
  const release = await lockfile.lock(dir, {
    realpath: true, stale: 10000, update: 2000, retries: lockRetries,
    onCompromised: () => {
      compromised = new Error('ledger lock compromised');
    },
  });
  const filename = path.join(dir, 'ledger.json');
  let data;
  let closed = false;
  let queue = Promise.resolve();
  try {
    // Exclusive lease is acquired before cleaning snapshots left by a crash.
    for (const name of await fs.readdir(dir)) {
      if (/^\.ledger-[0-9a-f-]+\.tmp$/.test(name)) {
        await fs.rm(path.join(dir, name), {force: true});
      }
    }
    const stat = await fs.stat(filename).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && stat.size > maxLedgerBytes) {
      throw new Error('ledger size limit exceeded');
    }
    data = stat ? JSON.parse(await fs.readFile(filename, 'utf8')) :
      {version: 1, entries: []};
    if (data.version !== 1 || !Array.isArray(data.entries)) {
      throw new Error('unsupported or corrupt ledger');
    }
    if (data.entries.length > maxRecords) {
      throw new Error('ledger record limit exceeded');
    }
    const ids = new Set();
    for (const entry of data.entries) {
      if (!entry.request || typeof entry.request.request_id !== 'string' ||
          ids.has(entry.request.request_id) ||
          !['pending', 'committed', 'failed', 'unknown'].includes(entry.state) ||
          !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 ||
          !Number.isSafeInteger(entry.enqueuedAt) || entry.enqueuedAt < 0 ||
          !Number.isSafeInteger(entry.nextAttemptAt) ||
          entry.nextAttemptAt < 0) {
        throw new Error('invalid ledger entry');
      }
      ids.add(entry.request.request_id);
    }
  } catch (error) {
    await release();
    throw error;
  }

  function checkOpen() {
    if (compromised) throw compromised;
    if (closed) throw new Error('ledger is closed');
  }

  async function persist(next) {
    checkOpen();
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > maxLedgerBytes) {
      throw new Error('ledger size limit exceeded');
    }
    const temporary = path.join(dir, `.ledger-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = null;
      checkOpen();
      await fs.rename(temporary, filename);
      const directory = await fs.open(dir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      data = next;
    } finally {
      if (handle) await handle.close();
      await fs.rm(temporary, {force: true});
    }
  }

  function mutate(update) {
    const operation = queue.then(async () => {
      checkOpen();
      const next = structuredClone(data);
      const result = update(next);
      await persist(next);
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    entries() {
      return structuredClone(data.entries);
    },
    add(request) {
      return mutate((next) => {
        if (next.entries.some((entry) =>
          entry.request.request_id === request.request_id)) {
          throw new Error('request ID already exists in ledger');
        }
        if (next.entries.length >= maxRecords) {
          throw new Error('ledger record limit exceeded');
        }
        if (next.entries.filter((entry) => entry.state === 'pending').length >=
            maxPending) {
          const error = new Error('ledger pending queue limit exceeded');
          error.code = 'PENDING_LIMIT';
          throw error;
        }
        next.entries.push({request: structuredClone(request), state: 'pending',
          attempts: 0, enqueuedAt: Date.now(), nextAttemptAt: 0,
          observations: []});
      });
    },
    update(id, changes) {
      return mutate((next) => {
        const entry = next.entries.find((item) =>
          item.request.request_id === id);
        if (!entry) throw new Error('unknown request ID');
        for (const key of Object.keys(changes)) {
          if (!['state', 'attempts', 'nextAttemptAt', 'completedAt',
            'lastError', 'observations'].includes(key)) {
            throw new Error('immutable ledger field');
          }
        }
        Object.assign(entry, structuredClone(changes));
      });
    },
    async close() {
      if (closed) return;
      await queue;
      closed = true;
      await release();
    },
  };
}

module.exports = {openLedger, positiveInteger};
