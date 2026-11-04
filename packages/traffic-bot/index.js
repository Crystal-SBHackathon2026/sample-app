const {randomUUID} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {openLedger, positiveInteger} = require('./ledger');
const {createHttpAdapter, HttpError} = require('./http-adapter');

const FIELDS = ['request_id', 'run_id', 'phase', 'request_no', 'payload',
  'created_at'];

function terminalError(code) {
  const error = new Error(code);
  error.code = code;
  error.terminal = true;
  return error;
}

function validateRequest(request) {
  if (!request || FIELDS.some((key) => typeof request[key] !== 'string') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          request.request_id) ||
      !request.run_id || request.run_id.length > 200 ||
      !request.phase || request.phase.length > 100 ||
      Buffer.byteLength(request.payload) > 64 * 1024 ||
      FIELDS.some((key) => request[key].includes('\0')) ||
      !/^(0|[1-9]\d*)$/.test(request.request_no) ||
      BigInt(request.request_no) > 9223372036854775807n ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(request.created_at) ||
      !Number.isFinite(Date.parse(request.created_at)) ||
      new Date(request.created_at).toISOString() !== request.created_at) {
    throw terminalError('INVALID_REQUEST');
  }
  return Object.fromEntries(FIELDS.map((key) => [key, request[key]]));
}

function validateResponse(body, expected) {
  if (!body || body.status !== 'committed' || !body.request ||
      FIELDS.some((key) => body.request[key] !== expected[key]) ||
      !body.database || typeof body.database.name !== 'string' ||
      !body.database.name || body.database.name.length > 256 ||
      typeof body.environment !== 'string' || !body.environment ||
      body.environment.length > 128) {
    throw terminalError('RESPONSE_MISMATCH');
  }
  return {environment: body.environment, database: {name: body.database.name},
    observedAt: new Date().toISOString()};
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function label(value) {
  return '"' + String(value).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '_')
      .replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
      .replace(/"/g, '\\"') + '"';
}

/** Durable single-writer load generator; storage and app transport are separate. */
async function createTrafficBot({adapter, ledgerDir, ratePerSecond = 1,
  maxPending = 1000, maxRecords = 100000, maxLedgerBytes = 64 * 1024 * 1024,
  maxRequestAgeMs = 300000, maxAttempts = 20, requestTimeoutMs = 5000,
  retryDelayMs = 1000, runId = randomUUID(), phase = 'onprem_live',
  onSummary = () => {}, lockRetries = 0} = {}) {
  if (!adapter || typeof adapter.write !== 'function' ||
      typeof adapter.read !== 'function') {
    throw new TypeError('adapter.write and adapter.read are required');
  }
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0 ||
      ratePerSecond > 1000) {
    throw new TypeError('ratePerSecond must be greater than 0 and at most 1000');
  }
  for (const [name, value] of Object.entries({maxRequestAgeMs, maxAttempts,
    requestTimeoutMs, retryDelayMs})) {
    positiveInteger(value, name);
  }
  if (typeof runId !== 'string' || !runId || runId.length > 200 ||
      typeof phase !== 'string' || !phase || phase.length > 100) {
    throw new TypeError('runId and phase must be bounded nonempty strings');
  }
  const ledger = await openLedger({dir: ledgerDir, maxPending, maxRecords,
    maxLedgerBytes, lockRetries});
  try {
    for (const entry of ledger.entries()) validateRequest(entry.request);
  } catch (error) {
    await ledger.close();
    throw error;
  }
  let stopped = false;
  let paused = false;
  let running = false;
  let processing;
  let loop;
  let summaryTimer;
  let generated = ledger.entries().filter((entry) =>
    entry.request.run_id === runId).reduce((last, entry) =>
      BigInt(entry.request.request_no) > last ?
        BigInt(entry.request.request_no) : last, 0n);
  const controllers = new Set();
  const counters = {write_attempts: 0, write_errors: 0, read_attempts: 0,
    read_errors: 0, generation_errors: 0, generation_blocked: 0};
  const latencies = [];
  const environments = new Map();
  let fatalCode = null;
  let finalSnapshot;
  const wake = new AbortController();

  function snapshot() {
    if (finalSnapshot) return structuredClone(finalSnapshot);
    const entries = ledger.entries();
    return {
      at: new Date().toISOString(), paused, running,
      pending: entries.filter((entry) => entry.state === 'pending').length,
      committed: entries.filter((entry) => entry.state === 'committed').length,
      failed: entries.filter((entry) => entry.state === 'failed').length,
      unknown: entries.filter((entry) => entry.state === 'unknown').length,
      ...counters, fatal: fatalCode,
      latency_ms: {p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99), max: Math.max(0, ...latencies)},
      environments: Object.fromEntries([...environments].map(([name, count]) =>
        [name, {count, ratio: count / Math.max(1,
          [...environments.values()].reduce((a, b) => a + b, 0))}])),
    };
  }

  async function call(method, argument) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const aborted = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        const error = new Error('REQUEST_ABORTED');
        error.code = 'REQUEST_ABORTED';
        reject(error);
      }, {once: true});
    });
    try {
      return await Promise.race([
        adapter[method](argument, {signal: controller.signal}), aborted,
      ]);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function commit(entry, response, priorObservation) {
    const observation = validateResponse(response, entry.request);
    const elapsed = Date.now() - entry.enqueuedAt;
    await ledger.update(entry.request.request_id, {
      state: 'committed', completedAt: Date.now(), lastError: null,
      observations: [...(priorObservation ? [priorObservation] : []), observation],
    });
    latencies.push(elapsed);
    if (latencies.length > 1000) latencies.shift();
    const key = environments.has(observation.environment) ||
      environments.size < 64 ? observation.environment : 'other';
    environments.set(key, (environments.get(key) || 0) + 1);
  }

  async function reconcile(entry) {
    counters.read_attempts++;
    try {
      return await call('read', entry.request.request_id);
    } catch (error) {
      counters.read_errors++;
      throw error;
    }
  }

  async function reconcileFinal(entry, code) {
    try {
      const found = await reconcile(entry);
      if (found) {
        await commit(entry, found);
        return;
      }
    } catch (error) {
      if (error.code === 'RESPONSE_MISMATCH') {
        await ledger.update(entry.request.request_id, {state: 'failed',
          lastError: 'RESPONSE_MISMATCH', completedAt: Date.now()});
        return;
      }
    }
    if (!stopped) {
      await ledger.update(entry.request.request_id, {state: 'unknown',
        lastError: code, completedAt: Date.now()});
    }
  }

  async function processEntry(entry) {
    if (Date.now() - entry.enqueuedAt >= maxRequestAgeMs) {
      if (entry.attempts > 0) {
        return reconcileFinal(entry, 'REQUEST_EXPIRED_UNCONFIRMED');
      }
      await ledger.update(entry.request.request_id,
          {state: 'failed', lastError: 'REQUEST_EXPIRED', completedAt: Date.now()});
      return;
    }
    let error;
    // A prior attempt could have committed even if its response was lost.
    if (entry.attempts > 0) {
      try {
        const found = await reconcile(entry);
        if (found) {
          await commit(entry, found);
          return;
        }
      } catch (cause) {
        error = cause;
      }
      if (error) return failOrRetry(entry, error);
    }
    if (entry.attempts >= maxAttempts) {
      await ledger.update(entry.request.request_id, {state: 'unknown',
        lastError: 'ATTEMPTS_EXHAUSTED_UNCONFIRMED', completedAt: Date.now()});
      return;
    }
    const attempts = entry.attempts + 1;
    await ledger.update(entry.request.request_id, {attempts});
    entry = {...entry, attempts};
    counters.write_attempts++;
    let receivedWrite = false;
    try {
      const result = await call('write', entry.request);
      receivedWrite = true;
      const observation = validateResponse(result, entry.request);
      const found = await reconcile(entry);
      if (!found) throw new Error('READ_NOT_FOUND');
      await commit(entry, found, observation);
      return;
    } catch (cause) {
      counters.write_errors++;
      error = cause;
    }
    if (!receivedWrite && error instanceof HttpError &&
        error.status === 503 && error.notCommitted === true && !stopped) {
      // This known refusal did not consume a potentially committed POST attempt.
      entry = {...entry, attempts: entry.attempts - 1};
      await ledger.update(entry.request.request_id, {attempts: entry.attempts});
      return failOrRetry(entry, error);
    }
    if (!error.terminal && !stopped) {
      try {
        const found = await reconcile(entry);
        if (found) {
          await commit(entry, found);
          return;
        }
      } catch (cause) {
        // A malformed reconciliation response must never be retried as success.
        if (cause.terminal) error = cause;
      }
    }
    return failOrRetry(entry, error);
  }

  async function failOrRetry(entry, error) {
    if (stopped) return;
    // Adapter errors are untrusted and may contain secrets; persist fixed codes.
    const safeCodes = ['RESPONSE_MISMATCH', 'INVALID_JSON_RESPONSE',
      'RESPONSE_TOO_LARGE', 'HTTP_TRANSPORT_ERROR', 'REQUEST_ABORTED',
      'WRITES_PAUSED'];
    const code = safeCodes.includes(error.code) ||
      /^HTTP_[0-9]{3}$/.test(error.code || '') ? error.code :
      (error.terminal ? 'PERMANENT_REQUEST_FAILURE' :
        'TRANSIENT_REQUEST_FAILURE');
    const failed = Boolean(error.terminal);
    await ledger.update(entry.request.request_id, {
      state: failed ? 'failed' : 'pending', lastError: code,
      nextAttemptAt: Date.now() + Math.min(maxRequestAgeMs,
          Math.max(retryDelayMs, error.retryAfterMs || 0)),
      ...(failed ? {completedAt: Date.now()} : {}),
    });
  }

  function processPending() {
    if (processing) return processing;
    processing = (async () => {
      for (const entry of ledger.entries()) {
        if (stopped || paused) break;
        if (entry.state === 'pending' && entry.nextAttemptAt <= Date.now()) {
          await processEntry(entry);
        }
      }
    })().finally(() => { processing = null; });
    return processing;
  }

  async function enqueue(request) {
    if (stopped) throw new Error('bot stopped');
    await ledger.add(validateRequest(request));
  }

  async function generate() {
    const sequence = generated + 1n;
    await enqueue({request_id: randomUUID(), run_id: runId, phase,
      request_no: String(sequence), payload: `synthetic-${sequence}`,
      created_at: new Date().toISOString()});
    generated = sequence;
  }

  function report() {
    try {
      onSummary(snapshot());
    } catch (error) {
      fatalCode = 'SUMMARY_CALLBACK_FAILED';
    }
  }

  return {
    enqueue, processPending, snapshot,
    async pause() {
      paused = true;
      if (processing) await processing;
    },
    resume() { paused = false; },
    start() {
      if (running || stopped) throw new Error('bot already started or stopped');
      running = true;
      summaryTimer = setInterval(report, 1000);
      loop = (async () => {
        // Recover all pending work once before creating a new request.
        await processPending();
        while (!stopped) {
          const started = Date.now();
          try {
            if (snapshot().pending >= maxPending) {
              counters.generation_blocked++;
            } else {
              await generate();
            }
          } catch (error) {
            if (error.code === 'PENDING_LIMIT') {
              counters.generation_blocked++;
            } else {
              counters.generation_errors++;
              fatalCode = 'LEDGER_GENERATION_LIMIT_OR_IO_ERROR';
              report();
              running = false;
              break;
            }
          }
          await processPending();
          if (!stopped) {
            await delay(Math.max(1,
                1000 / ratePerSecond - (Date.now() - started)), undefined,
            {signal: wake.signal}).catch((error) => {
              if (error.name !== 'AbortError') throw error;
            });
          }
        }
      })().catch(() => {
        fatalCode = 'LEDGER_PROCESSING_FAILED';
        running = false;
        report();
      });
      return loop;
    },
    metrics() {
      const value = snapshot();
      const lines = [
        '# HELP traffic_bot_requests_total Durable request outcomes',
        '# TYPE traffic_bot_requests_total gauge',
        ...['pending', 'committed', 'failed', 'unknown'].map((state) =>
          `traffic_bot_requests_total{state=${label(state)}} ${value[state]}`),
        '# TYPE traffic_bot_attempts_total counter',
        ...Object.entries(counters).map(([kind, count]) =>
          `traffic_bot_attempts_total{kind=${label(kind)}} ${count}`),
        '# TYPE traffic_bot_commit_latency_ms summary',
        `traffic_bot_commit_latency_ms{quantile="0.95"} ${value.latency_ms.p95}`,
        `traffic_bot_commit_latency_ms{quantile="0.99"} ${value.latency_ms.p99}`,
        '# TYPE traffic_bot_environment_commits_total counter',
        ...[...environments].map(([environment, count]) =>
          'traffic_bot_environment_commits_total' +
          `{environment=${label(environment)}} ${count}`),
        '# TYPE traffic_bot_paused gauge',
        `traffic_bot_paused ${paused ? 1 : 0}`,
      ];
      return `${lines.join('\n')}\n`;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      running = false;
      clearInterval(summaryTimer);
      wake.abort();
      for (const controller of controllers) controller.abort();
      if (loop) await loop;
      if (processing) await processing;
      finalSnapshot = snapshot();
      await ledger.close();
    },
  };
}

module.exports = {createTrafficBot, createHttpAdapter, openLedger, HttpError};
