#!/usr/bin/env node
const {createServer} = require('node:http');
const {createTrafficBot, createHttpAdapter} = require('..');

function numeric(env, name, fallback, integer = true) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value <= 0 ||
      (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

async function main(env = process.env) {
  const port = numeric(env, 'BOT_METRICS_PORT', 9091);
  if (port > 65535) throw new Error('Invalid BOT_METRICS_PORT');
  const bot = await createTrafficBot({
    adapter: createHttpAdapter({baseUrl: env.BOT_BASE_URL,
      requestsPath: env.BOT_REQUESTS_PATH || '/api/requests'}),
    ledgerDir: env.BOT_LEDGER_DIR || './data/ledger',
    ratePerSecond: numeric(env, 'BOT_RATE', 1, false),
    runId: env.BOT_RUN_ID,
    phase: env.BOT_PHASE || 'onprem_live',
    maxPending: numeric(env, 'BOT_MAX_PENDING', 1000),
    maxRecords: numeric(env, 'BOT_MAX_RECORDS', 100000),
    maxLedgerBytes: numeric(env, 'BOT_MAX_LEDGER_BYTES', 64 * 1024 * 1024),
    maxRequestAgeMs: numeric(env, 'BOT_MAX_REQUEST_AGE_MS', 300000),
    maxAttempts: numeric(env, 'BOT_MAX_ATTEMPTS', 20),
    requestTimeoutMs: numeric(env, 'BOT_REQUEST_TIMEOUT_MS', 5000),
    retryDelayMs: numeric(env, 'BOT_RETRY_DELAY_MS', 1000),
    lockRetries: {retries: 15, minTimeout: 1000, maxTimeout: 1000},
    onSummary: (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
  });
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return res.end(bot.metrics());
    }
    if (req.url === '/healthz') {
      const status = bot.snapshot();
      res.writeHead(status.fatal ? 503 : 200,
          {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({status: status.fatal ? 'fail' : 'ok'}));
    }
    res.writeHead(404);
    res.end();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, env.BOT_METRICS_HOST || '0.0.0.0', resolve);
    });
  } catch (error) {
    await bot.stop();
    throw error;
  }
  let shutdown;
  async function stop() {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      await bot.stop();
      await new Promise((resolve) => server.close(resolve));
    })();
    return shutdown;
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await bot.start();
  if (bot.snapshot().fatal) {
    process.exitCode = 1;
    await stop();
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error('traffic-bot startup or runtime failed; check configuration');
    process.exitCode = 1;
  });
}

module.exports = {main, numeric};
