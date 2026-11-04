const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {mkdtemp, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {Pool} = require('pg');
const {readFileSync} = require('node:fs');
const {createPostgresRequestStore} = require('@team-ghost/request-store');
const {createTrafficBot, createHttpAdapter} = require('@team-ghost/traffic-bot');
const {createApp} = require('../src/app');

test('real PG + hosted API + bot reconcile response loss and replay ledger',
    {skip: !process.env.TEST_DATABASE_URL}, async (t) => {
      const connectionString = process.env.TEST_DATABASE_URL;
      const admin = new Pool({connectionString});
      await admin.query(readFileSync(join(__dirname,
          '../packages/request-store/schema.sql'), 'utf8'));
      const store = createPostgresRequestStore({connectionString});
      const app = createApp({store});
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      const directory = await mkdtemp(join(tmpdir(), 'ghost-e2e-'));
      const runId = `e2e-${randomUUID()}`;
      let bot;
      t.after(async () => {
        if (bot) await bot.stop();
        await new Promise((resolve) => server.close(resolve));
        await store.close();
        await admin.query('DELETE FROM migration_demo WHERE run_id=$1', [runId]);
        await admin.end();
        await rm(directory, {recursive: true, force: true});
      });
      const adapter = createHttpAdapter({baseUrl: base});
      let dropped = false;
      bot = await createTrafficBot({ledgerDir: directory, runId,
        retryDelayMs: 1, adapter: {
          read: (...args) => adapter.read(...args),
          write: async (...args) => {
            const reply = await adapter.write(...args);
            if (!dropped) { dropped = true; throw new Error('lost response'); }
            return reply;
          },
        }});
      const record = {
        request_id: randomUUID(), run_id: runId, phase: 'onprem_live',
        request_no: '1', payload: 'E2E synthetic data',
        created_at: new Date().toISOString(),
      };
      await bot.enqueue(record);
      await bot.processPending();
      assert.equal(bot.snapshot().committed, 1);
      assert.equal((await admin.query(
          'SELECT count(*)::text AS n FROM migration_demo WHERE run_id=$1',
          [runId])).rows[0].n, '1');
      await bot.stop();
      bot = await createTrafficBot({ledgerDir: directory, runId, adapter});
      await bot.processPending();
      assert.equal(bot.snapshot().committed, 1);
      assert.deepEqual((await store.get(record.request_id)).request, record);
      await store.pauseWrites();
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
      assert.equal((await fetch(
          `${base}/api/requests/${record.request_id}`)).status, 200);
    });
