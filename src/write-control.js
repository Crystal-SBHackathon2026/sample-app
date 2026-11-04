const {readFile} = require('node:fs/promises');

/** Refresh a local pause flag; DB-wide fencing remains the orchestrator's job. */
function createWriteControl({store, file, initiallyPaused = false}) {
  let healthy = true;
  let pending = Promise.resolve();
  function pause() {
    // pauseWrites sets the flag before its first await. Reads must not wait
    // for a slow in-flight write; callers can inspect inFlightWrites to drain.
    store.pauseWrites().catch(() => { healthy = false; });
  }
  if (initiallyPaused && store) pause();

  function refresh() {
    if (!file || !store) return Promise.resolve();
    pending = pending.catch(() => {}).then(async () => {
      try {
        const config = JSON.parse(await readFile(file, 'utf8'));
        if (typeof config.writes_paused !== 'boolean') {
          throw new Error('Invalid write control file');
        }
        if (initiallyPaused || config.writes_paused) {
          pause();
        } else {
          store.resumeWrites();
        }
        healthy = true;
      } catch {
        healthy = false;
        pause();
      }
    });
    return pending;
  }

  return {refresh, get healthy() { return healthy; }};
}

module.exports = {createWriteControl};
