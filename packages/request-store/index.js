const {Pool, defaults: driverDefaults} = require('pg');
const {RequestStoreError, normalizeId, normalizeRequest} = require('./request');
const {isUrlTlsKey, postgresOptionsFromEnv} = require('./config');

const COLUMNS =
    'request_id, run_id, phase, request_no::text, payload, created_at';
const SELECT =
    `SELECT ${COLUMNS} FROM public.migration_demo WHERE request_id=$1`;
const INSERT = `INSERT INTO public.migration_demo
    (request_id, run_id, phase, request_no, payload, created_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (request_id) DO NOTHING RETURNING ${COLUMNS}`;

function unavailable() {
  return new RequestStoreError('DB_UNAVAILABLE', 'Database is unavailable');
}

function invalidConfiguration(message) {
  return new RequestStoreError('INVALID_CONFIGURATION', message, 500);
}

/** Mirrors pg 8, which reads PGSSLMODE then pg.defaults when ssl is omitted. */
function driverDefaultSsl() {
  const mode = process.env.PGSSLMODE;
  if (mode === 'disable') return false;
  if (['prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) {
    return true;
  }
  if (mode === 'no-verify') return mode;
  return driverDefaults.ssl ?? false;
}

/**
 * Accepts only false, true or an object that keeps certificate and host
 * verification on; pg turns strings such as 'no-verify' into unverified TLS.
 * Returns false or TLS options with rejectUnauthorized pinned to true, so
 * NODE_TLS_REJECT_UNAUTHORIZED=0 cannot fill in an unverified default.
 */
function verifiedTls(ssl) {
  const effective = ssl === undefined ? driverDefaultSsl() : ssl;
  if (effective === false) return false;
  if (effective === true) return {rejectUnauthorized: true};
  const verifies = effective !== null && typeof effective === 'object' &&
      !Array.isArray(effective) &&
      (!('rejectUnauthorized' in effective) ||
          effective.rejectUnauthorized === true) &&
      !('checkServerIdentity' in effective);
  if (!verifies) {
    throw invalidConfiguration(
        'TLS certificate verification must remain enabled');
  }
  return {...effective, rejectUnauthorized: true};
}

function assertUrlWithoutSsl(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    // URL errors keep the raw input, which may contain credentials.
    throw invalidConfiguration('connectionString must be a PostgreSQL URL');
  }
  // pg parses the URL again and its TLS keys override the pinned ssl option.
  if ([...url.searchParams.keys()].some(isUrlTlsKey)) {
    throw invalidConfiguration(
        'Use postgresOptionsFromEnv or explicit ssl options without URL SSL parameters');
  }
}

function rowRecord(row) {
  return {...row, created_at: row.created_at instanceof Date ?
    row.created_at.toISOString() : new Date(row.created_at).toISOString()};
}

function createPostgresRequestStore(options = {}) {
  const poolFactory = options.poolFactory || ((config) => new Pool(config));
  let pool;
  let paused = Boolean(options.writesPaused);
  let closed = false;
  let closing = false;
  let closePromise;
  // replacing blocks writes, resume and another swap until cleanup ends.
  // swapPending additionally blocks reads until the validated pool is in use.
  let replacing = false;
  let swapPending = false;
  const replacementWaiters = [];
  let inFlightWrites = 0;
  const drainWaiters = [];

  function observe(operation, outcome, started) {
    if (options.onObservation) {
      try {
        options.onObservation({operation, outcome,
          seconds: Number(process.hrtime.bigint() - started) / 1e9});
      } catch {
        // Instrumentation must not change a committed request's outcome.
      }
    }
  }

  function makePool(config) {
    const {statementTimeoutMillis = 5000, poolFactory: ignored,
      onObservation: callback, writesPaused: initial, ...rest} = config;
    if (rest.connectionString) assertUrlWithoutSsl(rest.connectionString);
    const ssl = verifiedTls(rest.ssl);
    const created = poolFactory({
      max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000,
      keepAlive: true,
      ...rest, ssl, statement_timeout: statementTimeoutMillis,
      query_timeout: statementTimeoutMillis + 1000,
    });
    // Idle connection errors must not terminate the whole Node process.
    created.on('error', () => observe('connection', 'error',
        process.hrtime.bigint()));
    return created;
  }

  pool = makePool(options);

  function ensureReadable() {
    if (closed || closing || swapPending) throw unavailable();
  }

  function ensureAvailable() {
    ensureReadable();
    if (replacing) throw unavailable();
  }

  async function endRetiredPool(retired) {
    const started = process.hrtime.bigint();
    try {
      await retired.end();
    } catch {
      // The candidate already serves requests; a failed end is only observed.
      observe('connection', 'error', started);
    }
  }

  async function useClient(operation, action) {
    const started = process.hrtime.bigint();
    let client;
    let discardError;
    try {
      ensureReadable();
      client = await pool.connect();
      const result = await action(client);
      observe(operation, 'success', started);
      return result;
    } catch (error) {
      observe(operation, 'error', started);
      if (error instanceof RequestStoreError) throw error;
      discardError = error;
      throw unavailable();
    } finally {
      if (client) client.release(discardError);
    }
  }

  function finishWrite() {
    inFlightWrites--;
    if (inFlightWrites === 0) {
      for (const resolve of drainWaiters.splice(0)) {
        resolve();
      }
    }
  }

  function drainWrites() {
    if (inFlightWrites === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  const store = {
    get writesPaused() { return paused; },
    get inFlightWrites() { return inFlightWrites; },

    async put(input) {
      const record = normalizeRequest(input);
      ensureAvailable();
      if (paused) {
        throw new RequestStoreError('WRITES_PAUSED',
            'Writes are temporarily paused');
      }
      // Reserve synchronously so pauseWrites cannot miss an accepted request.
      inFlightWrites++;
      try {
        return await useClient('write', async (client) => {
          let transaction = false;
          try {
            await client.query('BEGIN');
            transaction = true;
            const params = Object.values(record);
            const inserted = await client.query(INSERT, params);
            let row = inserted.rows[0];
            if (!row) {
              // A second READ COMMITTED statement sees concurrent commits
              // which ON CONFLICT waited for but did not insert itself.
              const existing = await client.query(`${SELECT} AND
                run_id=$2 AND phase=$3 AND request_no=$4 AND payload=$5
                AND created_at=$6`, params);
              row = existing.rows[0];
              if (!row) {
                throw new RequestStoreError('REQUEST_CONFLICT',
                    'request_id already exists with different content', 409);
              }
            }
            const database = (await client.query(
                'SELECT current_database() AS name')).rows[0];
            await client.query('COMMIT');
            transaction = false;
            return {created: inserted.rowCount === 1,
              request: rowRecord(row), database};
          } catch (error) {
            if (transaction) {
              await client.query('ROLLBACK');
            }
            throw error;
          }
        });
      } finally {
        finishWrite();
      }
    },

    async get(id) {
      const normalized = normalizeId(id);
      return useClient('read', async (client) => {
        const result = await client.query(SELECT, [normalized]);
        const database = (await client.query(
            'SELECT current_database() AS name')).rows[0];
        return {request: result.rows[0] ? rowRecord(result.rows[0]) : null,
          database};
      });
    },

    async checkReady() {
      return useClient('readiness', async (client) => {
        await client.query(`SELECT ${COLUMNS}
          FROM public.migration_demo LIMIT 0`);
        return (await client.query(
            'SELECT current_database() AS name')).rows[0];
      });
    },

    async status() {
      return useClient('status', async (client) => {
        const result = await client.query(`SELECT current_database() AS name,
          count(*)::text AS row_count FROM public.migration_demo`);
        return result.rows[0];
      });
    },

    async pauseWrites() {
      paused = true;
      await drainWrites();
    },

    resumeWrites() {
      ensureAvailable();
      paused = false;
    },

    async replaceConnection(nextOptions) {
      ensureAvailable();
      if (!paused) {
        throw new RequestStoreError('WRITES_NOT_PAUSED',
            'Pause and drain writes before replacing the database', 409);
      }
      replacing = true;
      swapPending = true;
      let candidate;
      try {
        await drainWrites();
        candidate = makePool(nextOptions);
        await candidate.query(`SELECT ${COLUMNS}
          FROM public.migration_demo LIMIT 0`);
        const retired = pool;
        pool = candidate;
        candidate = null;
        swapPending = false;
        await endRetiredPool(retired);
      } catch {
        throw unavailable();
      } finally {
        if (candidate) await candidate.end().catch(() => {});
        swapPending = false;
        replacing = false;
        for (const resolve of replacementWaiters.splice(0)) {
          resolve();
        }
      }
    },

    close() {
      if (closePromise) return closePromise;
      paused = true;
      closing = true;
      closePromise = (async () => {
        // A swap owns both pools until its finally block. Wait before ending
        // the surviving pool, and prohibit resume/read/write while closing.
        if (replacing) {
          await new Promise((resolve) => replacementWaiters.push(resolve));
        }
        closed = true;
        await drainWrites();
        await pool.end();
      })();
      return closePromise;
    },
  };
  return store;
}

module.exports = {
  createPostgresRequestStore, RequestStoreError, normalizeRequest,
  postgresOptionsFromEnv,
};
