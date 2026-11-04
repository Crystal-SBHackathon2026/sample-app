const {readFile} = require('node:fs/promises');

/**
 * Refresh a local pause flag; DB-wide fencing remains the orchestrator's job.
 * onHealthChange(healthy) runs only when the control health flips.
 */
function createWriteControl({
  store, file, initiallyPaused = false, onHealthChange = () => {},
}) {
  let healthy = true;
  let pending = Promise.resolve();
  function setHealthy(next) {
    if (next === healthy) return;
    healthy = next;
    onHealthChange(next);
  }
  function pause() {
    // pauseWrites sets the flag before its first await. Reads must not wait
    // for a slow in-flight write; callers can inspect inFlightWrites to drain.
    store.pauseWrites().catch(() => setHealthy(false));
  }
  if (initiallyPaused && store) pause();

  function refresh() {
    if (!file || !store) return Promise.resolve();
    pending = pending.catch(() => {}).then(async () => {
      let config;
      try {
        config = JSON.parse(await readFile(file, 'utf8'));
        if (typeof config.writes_paused !== 'boolean') {
          throw new Error('Invalid write control file');
        }
      } catch {
        // Fail closed for writes only; reads and readiness stay available.
        pause();
        setHealthy(false);
        return;
      }
      // Only reading and parsing the file decide its health.
      setHealthy(true);
      if (initiallyPaused || config.writes_paused) {
        pause();
        return;
      }
      try {
        store.resumeWrites();
      } catch {
        // The store refuses resume while replacing or closing its pool.
        // That is DB state, not a bad file; writes stay paused.
        pause();
      }
    });
    return pending;
  }

  return {refresh, get healthy() { return healthy; }};
}

module.exports = {createWriteControl};
