const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {randomUUID} = require('node:crypto');
const {Pool} = require('pg');
const express = require('express');
const {createPostgresRequestStore} = require('../packages/request-store');
const {createRequestRouter} = require('../packages/request-store/express');

const connectionString = process.env.TEST_DATABASE_URL;

test('real PostgreSQL API: duplicate, conflict, pause/read and pool replacement',
    {skip: !connectionString}, async (t) => {
      // Only TEST_DATABASE_URL is used. Rows owned by this test run are removed.
      const admin = new Pool({connectionString});
      const run = `test-${randomUUID()}`;
      const store = createPostgresRequestStore({connectionString});
      let server;
      t.after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        await store.close();
        await admin.query('DELETE FROM public.migration_demo WHERE run_id=$1',
            [run]);
        await admin.end();
      });
      await admin.query(readFileSync(join(__dirname,
          '../packages/request-store/schema.sql'), 'utf8'));
      const input = {
        request_id: randomUUID(), run_id: run, phase: 'onprem_live',
        request_no: '9223372036854775807', payload: "quoted ' input",
        created_at: '2026-11-04T00:00:00.123Z',
      };
      const writes = await Promise.all(
          Array.from({length: 8}, () => store.put(input)));
      assert.equal(writes.filter((result) => result.created).length, 1);
      assert.deepEqual((await store.get(input.request_id)).request, input);
      assert.equal((await admin.query(
          'SELECT count(*)::text AS n FROM public.migration_demo WHERE run_id=$1',
          [run])).rows[0].n, '1');
      for (const patch of [
        {payload: 'different'}, {run_id: 'another'}, {phase: 'aws_live'},
        {request_no: '1'}, {created_at: '2026-11-04T00:00:00.124Z'},
      ]) {
        await assert.rejects(store.put({...input, ...patch}),
            {code: 'REQUEST_CONFLICT'});
      }
      await assert.rejects(store.replaceConnection({connectionString}),
          {code: 'WRITES_NOT_PAUSED'});
      const app = express();
      app.use('/api/requests', createRequestRouter({store,
        getContext: () => ({environment: 'test', region: 'local'})}));
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}/api/requests`;
      let response = await fetch(base, {method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(input)});
      assert.equal(response.status, 200);
      assert.equal((await response.json()).environment, 'test');
      response = await fetch(base, {method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({...input, payload: 'conflict'})});
      assert.equal(response.status, 409);
      response = await fetch(base, {method: 'POST',
        headers: {'content-type': 'application/json'}, body: '{invalid'});
      assert.equal(response.status, 400);
      response = await fetch(base, {method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({...input, request_id: randomUUID(),
          payload: '\u0001'.repeat(65536)})});
      assert.equal(response.status, 201,
          'escaped valid 64KiB payload fits the HTTP body limit');
      await store.pauseWrites();
      response = await fetch(base, {method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(input)});
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '1');
      response = await fetch(`${base}/${input.request_id}`);
      assert.equal(response.status, 200);
      response = await fetch(`${base}/${randomUUID()}`);
      assert.equal(response.status, 404);
      await store.replaceConnection({connectionString});
      assert.equal(store.writesPaused, true);
      assert.deepEqual((await store.get(input.request_id)).request, input);
      const invalidConnection = new URL(connectionString);
      invalidConnection.pathname = `/missing_${randomUUID().replaceAll('-', '')}`;
      await assert.rejects(store.replaceConnection({
        connectionString: invalidConnection.toString(),
        connectionTimeoutMillis: 100,
      }), {code: 'DB_UNAVAILABLE'});
      assert.equal(store.writesPaused, true);
      assert.deepEqual((await store.get(input.request_id)).request, input);
      store.resumeWrites();
      assert.equal((await store.put({...input,
        request_id: randomUUID()})).created, true);
    });
