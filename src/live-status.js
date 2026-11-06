const RECENT_LIMIT = 20;
const REQUEST_ID_PREFIX_LENGTH = 8;
const CACHE_MILLIS = 1000;
// The screen must tell "DB down" from "app down", so answer before it gives up.
const DB_WAIT_MILLIS = 2000;

function publicRow(row) {
  return {
    request_id_prefix: row.request_id.slice(0, REQUEST_ID_PREFIX_LENGTH),
    run_id: row.run_id, phase: row.phase, created_at: row.created_at,
  };
}

function rejectAfter(millis) {
  let timer;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('DB wait expired')), millis);
  });
  return {expired, cancel: () => clearTimeout(timer)};
}

/**
 * Builds the public /api/live answer. Viewers share one DB read per second,
 * outages included, because the pool also serves committed requests.
 */
function createLiveStatus({store, control, appInfo}) {
  let cached;
  let cachedUntil = 0;
  let reading = null;

  function remember(result, freshFromMillis) {
    cached = result;
    cachedUntil = freshFromMillis + CACHE_MILLIS;
    return result;
  }

  /**
   * Counting from the read's start lets a viewer polling every second get a
   * new read each time, still one per second at most. A read slower than the
   * cache counts from its end, or its result would expire before being served.
   */
  function freshFrom(startedMillis) {
    const finishedMillis = Date.now();
    return finishedMillis - startedMillis < CACHE_MILLIS ?
        startedMillis : finishedMillis;
  }

  function readSnapshotOnce() {
    // Viewers share one read, which may outlive any viewer's wait. A hung DB
    // therefore holds one connection, and a slow success still reaches the
    // next poll instead of being thrown away.
    if (!reading) {
      const startedMillis = Date.now();
      reading = store.liveSnapshot(RECENT_LIMIT).then((snapshot) => remember({
        database: {name: snapshot.name, row_count: snapshot.row_count},
        recent: snapshot.recent.map(publicRow),
        observed_at: new Date().toISOString(),
      }, freshFrom(startedMillis))).finally(() => { reading = null; });
    }
    return reading;
  }

  async function cachedDatabaseResult() {
    if (cached && Date.now() < cachedUntil) return cached;
    const limit = rejectAfter(DB_WAIT_MILLIS);
    try {
      if (!store) throw new Error('DB not configured');
      return await Promise.race([readSnapshotOnce(), limit.expired]);
    } catch {
      return remember({database: null, recent: [],
        observed_at: new Date().toISOString()}, Date.now());
    } finally {
      limit.cancel();
    }
  }

  async function read() {
    // Pause state is a local file read, so it stays current on every request.
    await control.refresh();
    const result = await cachedDatabaseResult();
    const body = {
      environment: appInfo.environment, region: appInfo.region,
      version: appInfo.version, ...result,
      writes_paused: store?.writesPaused || false,
    };
    if (result.database) return {status: 200, body};
    return {status: 503, body: {...body, error: {
      code: 'DB_UNAVAILABLE', message: 'Database unavailable',
    }}};
  }

  return {read};
}

module.exports = {createLiveStatus};
