const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {Pool} = require('pg');
const {createPostgresRequestStore} = require('@team-ghost/request-store');

const connectionString = process.env.TEST_DATABASE_URL;

test('actual app role needs SELECT/INSERT only and cannot own schema changes',
    {skip: !connectionString}, async (t) => {
      const admin = new Pool({connectionString});
      const role = `ghost_${randomUUID().replaceAll('-', '')}`;
      const password = randomUUID();
      const id = randomUUID();
      let store;
      t.after(async () => {
        if (store) await store.close();
        await admin.query('DELETE FROM migration_demo WHERE request_id=$1', [id]);
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
        await admin.end();
      });
      // Identifiers and password are locally generated UUIDs, not user input.
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await admin.query(`GRANT SELECT, INSERT ON migration_demo TO "${role}"`);
      const url = new URL(connectionString);
      url.username = role;
      url.password = password;
      store = createPostgresRequestStore({connectionString: url.toString()});
      const record = {request_id: id, run_id: 'privilege-test',
        phase: 'onprem_live', request_no: '1', payload: 'limited role',
        created_at: new Date().toISOString()};
      assert.equal((await store.put(record)).created, true);
      assert.equal((await store.put(record)).created, false);
      assert.deepEqual((await store.get(id)).request, record);
      await store.checkReady();
      await assert.rejects(store.put({...record, payload: 'different'}),
          {code: 'REQUEST_CONFLICT'});
      const client = new Pool({connectionString: url.toString()});
      try {
        await assert.rejects(client.query('DELETE FROM migration_demo'),
            {code: '42501'});
        await assert.rejects(client.query(
            'CREATE TABLE public.must_not_create (id integer)'), {code: '42501'});
      } finally { await client.end(); }
    });
