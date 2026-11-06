const {test} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {once} = require('node:events');
const express = require('express');
const {createClient} = require('redis');
const {createIngress} = require('../src/durable-ingress/service');

test('live control gates writes, drains in-flight, fences stale epoch and preserves accepted data',
  {skip: !process.env.TEST_REDIS_URL}, async (t) => {
    const r = createClient({url: process.env.TEST_REDIS_URL});
    await r.connect();
    // TEST_REDIS_URL must name a dedicated disposable Redis instance.
    await r.flushDb();
    const rows = new Map(); let release; let started;
    let wait = new Promise((resolve) => { release = resolve; });
    const writing = new Promise((resolve) => { started = resolve; });
    const backend = express(); backend.use(express.json());
    backend.post('/api/requests', async (req, res) => {
      started(); await wait; rows.set(req.body.request_id, req.body);
      res.json({status: 'committed'});
    });
    backend.get('/api/requests/:id', (req, res) => {
      const request = rows.get(req.params.id);
      if (!request) return res.sendStatus(404);
      res.json({status: 'committed', request, database: {name: 'test'}, environment: 'test'});
    });
    const host = backend.listen(0); await once(host, 'listening');
    const targets = {onprem: {url: `http://127.0.0.1:${host.address().port}`},
      aws: {url: `http://127.0.0.1:${host.address().port}`}};
    let app = await createIngress({redis: r, targets});
    let api = app.api.listen(0); let ctl = app.control.listen(0); await once(ctl, 'listening');
    t.after(async () => { release(); await app.close(); api.close(); ctl.close(); host.close(); await r.quit(); });
    const call = async (server, path, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: body ? 'POST' : 'GET', headers: {'Content-Type': 'application/json'},
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
      return {status: response.status, body: await response.json()};
    };
    const request = {request_id: randomUUID(), run_id: 'control', phase: 'test',
      request_no: '1', payload: 'data', created_at: new Date().toISOString()};
    assert.equal((await call(api, '/api/requests', request)).status, 202);
    assert.equal(rows.size, 0);
    await assert.rejects(createIngress({redis: r, targets}), /CONSUMER_ALREADY_RUNNING/);
    assert.equal((await call(ctl, '/resume', {expected_epoch: '9'})).status, 409);
    await call(ctl, '/resume', {expected_epoch: '0'}); await writing;
    let paused = false;
    const pause = call(ctl, '/pause', {}).then((result) => { paused = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(paused, false, 'pause must wait for active DB commit/readback');
    release(); const result = await pause;
    assert.equal(result.body.settled, true); assert.equal(result.body.in_flight, 0);
    assert.equal((await call(api, '/api/requests/' + request.request_id)).body.status, 'committed');
    assert.equal((await call(ctl, '/target', {target: 'aws', expected_epoch: '0'})).body.epoch, '1');
    assert.equal((await call(ctl, '/resume', {expected_epoch: '0'})).status, 409);
    await app.close(); api.close(); ctl.close();
    app = await createIngress({redis: r, targets});
    api = app.api.listen(0); ctl = app.control.listen(0); await once(ctl, 'listening');
    const state = (await call(ctl, '/status')).body;
    assert.equal(state.target, 'aws'); assert.equal(state.epoch, '1'); assert.equal(state.mode, 'paused');
    assert.equal((await call(api, '/api/requests', {...request, payload: 'different'})).status, 409);
    assert.equal(rows.size, 1);
  });
