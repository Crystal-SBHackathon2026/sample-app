const express = require('express');
const {createRequestRouter} = require('@team-ghost/request-store/express');
const {createMetrics} = require('./metrics');
const {createStoreFromEnv} = require('./db');
const {createRequestApiAuth} = require('./request-api-auth');
const {createWriteControl} = require('./write-control');

const info = {
  app: 'sample-app',
  version: process.env.APP_VERSION || 'dev',
  environment: process.env.DEPLOY_ENV || 'local',
  region: process.env.DEPLOY_REGION || 'local',
  startedAt: new Date().toISOString(),
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

/** Create a sample host; the request package can be mounted in other apps. */
function createApp(options = {}) {
  const env = options.env || process.env;
  const appInfo = {...info, ...options.info};
  const app = express();
  app.disable('x-powered-by');
  const metrics = createMetrics({
    app: appInfo.app, environment: appInfo.environment,
  });
  const store = options.store === undefined ?
      createStoreFromEnv(env, metrics.observeDatabase) : options.store;
  const logger = options.logger || console;
  const control = createWriteControl({
    store,
    file: env.APP_CONTROL_FILE,
    initiallyPaused: env.WRITES_PAUSED === 'true',
    onHealthChange: (healthy) => {
      metrics.setWriteControlHealthy(healthy);
      logger.warn(healthy ?
          'write control file recovered' :
          'write control file invalid; writes stay paused');
    },
  });
  const requestApiAuth = createRequestApiAuth({env, logger, metrics});
  app.locals.store = store;
  app.locals.draining = false;
  app.locals.close = async () => {
    if (store) await store.close();
  };
  app.use(metrics.middleware);

  app.get('/metrics', async (req, res, next) => {
    try {
      res.set('Content-Type', metrics.register.contentType);
      res.send(await metrics.register.metrics());
    } catch (error) { next(error); }
  });

  app.get('/healthz', (req, res) => {
    if (env.HEALTH_FAIL === 'true') {
      return res.status(503).json({status: 'fail'});
    }
    res.json({status: 'ok'});
  });

  let cachedStatus;
  let statusExpiresAt = 0;
  let statusPending;
  async function databaseStatus() {
    await control.refresh();
    if (!store) throw new Error('DB unavailable');
    if (cachedStatus && Date.now() < statusExpiresAt) return cachedStatus;
    // Coalesce diagnostic counts; public diagnostics must not exhaust the
    // same connection pool that commits requests. Readiness never counts rows.
    if (!statusPending) {
      statusPending = store.status().then((database) => {
        cachedStatus = database;
        statusExpiresAt = Date.now() + 1000;
        return database;
      }).finally(() => { statusPending = null; });
    }
    const database = await statusPending;
    metrics.setDatabase(database.name);
    return database;
  }

  app.get('/readyz', async (req, res) => {
    try {
      // Control health only gates writes; readiness reflects DB reads.
      await control.refresh();
      if (!store || app.locals.draining) {
        throw new Error('Not ready');
      }
      const database = store.checkReady ?
          await store.checkReady() : await store.status();
      // An outage clears the DB identity; a successful check restores it.
      if (database?.name) metrics.setDatabase(database.name);
      res.json({status: 'ok'});
    } catch {
      metrics.setDatabase(null);
      res.status(503).json({status: 'unavailable'});
    }
  });

  app.get('/api/info', async (req, res) => {
    const failRate = Number(env.FAIL_RATE || 0);
    if (failRate > 0 && Math.random() < failRate) {
      return res.status(500).json({error: 'injected failure'});
    }
    try {
      const database = store ? await databaseStatus() : null;
      res.json({
        ...appInfo, database, writes_paused: store?.writesPaused || false,
        writes_in_flight: store?.inFlightWrites || 0,
        write_control: {healthy: control.healthy},
      });
    } catch {
      res.status(503).json({error: {
        code: 'DB_UNAVAILABLE', message: 'Database unavailable',
      }});
    }
  });

  // Auth answers before the control file, the body parser and the store.
  app.use('/api/requests', requestApiAuth.middleware);
  app.use('/api/requests', async (req, res, next) => {
    try {
      await control.refresh();
      if (!store) {
        return res.status(503).json({error: {
          code: 'DB_UNAVAILABLE', message: 'Database not configured',
        }});
      }
      next();
    } catch (error) { next(error); }
  }, createRequestRouter({store, getContext: () => ({
    environment: appInfo.environment, region: appInfo.region,
  })}));

  app.get('/', async (req, res) => {
    let databaseText = 'DB 연결 없음';
    try {
      const database = await databaseStatus();
      databaseText = `${database.name} · ${database.row_count}건`;
    } catch { /* Keep the diagnostic page available during a DB outage. */ }
    const version = appInfo.version.length === 40 ?
        appInfo.version.slice(0, 7) : appInfo.version;
    res.type('html').send(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>Ghost Migration Demo</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:60px auto">
  <h1>Ghost Migration Demo</h1>
  <p>응답한 환경: <b>${escapeHtml(appInfo.environment)}</b>
    (${escapeHtml(appInfo.region)})</p>
  <p>버전: <b>${escapeHtml(version)}</b></p>
  <p>기동 시각: <b>${escapeHtml(appInfo.startedAt)}</b></p>
  <p>연결 DB: <b>${escapeHtml(databaseText)}</b></p>
  <p>쓰기 상태: <b>${store?.writesPaused ? '일시 정지' : '허용'}</b></p>
</body></html>`);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({error: {
      code: 'INTERNAL_ERROR', message: 'Request failed',
    }});
  });
  return app;
}

module.exports = {createApp, info};
