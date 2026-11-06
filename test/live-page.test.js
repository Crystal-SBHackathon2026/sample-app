const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createIngestTracker, renderLivePage} = require('../src/live-page');

const IDENTITY = 'aws/demo';

function sample(tracker, rowCount, seconds, identity = IDENTITY) {
  tracker.record({identity, rowCount, observedAtMs: seconds * 1000,
    newestCreatedAtMs: null});
}

test('a steady stream reads as its true rate', () => {
  const tracker = createIngestTracker();
  sample(tracker, 100, 1000);
  for (let second = 1; second <= 10; second++) {
    sample(tracker, 100 + second * 5, 1000 + second);
  }
  assert.equal(tracker.averageRate(1009, 10), 5);
  assert.deepEqual(tracker.series(1009, 3), [5, 5, 5]);
});

test('the first sample is a baseline, not a burst of ingest', () => {
  const tracker = createIngestTracker();
  sample(tracker, 170000, 1000);
  assert.equal(tracker.averageRate(1000, 10), null);
  assert.deepEqual(tracker.series(1000, 2), [null, null]);
});

test('a gap spreads its growth by time and leaves older seconds unobserved',
    () => {
      const tracker = createIngestTracker();
      sample(tracker, 0, 1000);
      sample(tracker, 300, 1030);
      const series = tracker.series(1029, 30);
      assert.deepEqual(series.slice(-3), [10, 10, 10]);
      assert.deepEqual(series.slice(0, 27), new Array(27).fill(null));
      assert.equal(tracker.averageRate(1029, 10), 10);
    });

test('samples straddling second boundaries keep a steady rate flat', () => {
  const tracker = createIngestTracker();
  // Round times are poll jitter: 5 rows/s, sampled 1.02 s then 0.98 s apart.
  const times = [1000.99, 1002.01, 1002.99, 1004.01, 1004.99, 1006.01];
  times.forEach((seconds, index) => {
    const rows = index === 0 ? 0 : Math.round((seconds - times[0]) * 5);
    sample(tracker, rows, seconds);
  });
  for (const rate of tracker.series(1005, 4)) {
    assert.ok(Math.abs(rate - 5) < 0.3, String(rate));
  }
});

test('a sample with no growth is an observed zero, not a gap', () => {
  const tracker = createIngestTracker();
  sample(tracker, 10, 1000);
  sample(tracker, 10, 1001);
  assert.deepEqual(tracker.series(1000, 1), [0]);
  assert.equal(tracker.averageRate(1000, 10), 0);
});

test('replicas answering out of step never inflate an insert-only count',
    () => {
      const tracker = createIngestTracker();
      sample(tracker, 100, 1000);
      sample(tracker, 105, 1001);
      sample(tracker, 103, 1002);
      sample(tracker, 105, 1003);
      sample(tracker, 106, 1004);
      assert.deepEqual(tracker.series(1003, 4), [5, 0, 0, 1]);
    });

test('a cached or older sample is ignored', () => {
  const tracker = createIngestTracker();
  sample(tracker, 100, 1000);
  sample(tracker, 110, 1002);
  sample(tracker, 110, 1002);
  sample(tracker, 111, 1001);
  assert.deepEqual(tracker.series(1001, 2), [5, 5]);
  sample(tracker, 115, 1003);
  assert.deepEqual(tracker.series(1002, 1), [5]);
});

test('switching database is a new baseline, not a spike', () => {
  const tracker = createIngestTracker();
  sample(tracker, 100, 1000);
  sample(tracker, 101, 1001);
  sample(tracker, 170675, 1002, 'onprem/migration_demo_return');
  assert.deepEqual(tracker.series(1001, 2), [1, null]);
  sample(tracker, 170676, 1003, 'onprem/migration_demo_return');
  assert.deepEqual(tracker.series(1002, 1), [1]);
});

test('a database rebuilt under the same name is a new baseline', () => {
  const tracker = createIngestTracker();
  sample(tracker, 170000, 1000);
  assert.equal(tracker.record({identity: IDENTITY, rowCount: 3,
    observedAtMs: 1001000, newestCreatedAtMs: null}), 'baseline');
  assert.equal(tracker.highestCount(), 3);
});

test('only a fall of more than 10% counts as a rebuilt database', () => {
  const tracker = createIngestTracker();
  const next = (rowCount, seconds) => tracker.record({identity: IDENTITY,
    rowCount, observedAtMs: seconds * 1000, newestCreatedAtMs: null});
  next(1000, 1000);
  assert.equal(next(900, 1001), 'newer');
  assert.equal(next(899, 1002), 'baseline');
});

test('an older answer stays stale even when its count looks like a rebuild',
    () => {
      const tracker = createIngestTracker();
      sample(tracker, 9, 1000);
      sample(tracker, 10, 1001);
      assert.equal(tracker.record({identity: IDENTITY, rowCount: 8,
        observedAtMs: 1000500, newestCreatedAtMs: null}), 'stale');
      assert.equal(tracker.highestCount(), 10);
    });

test('forgetting drops history and the next sample is a new baseline', () => {
  const tracker = createIngestTracker();
  sample(tracker, 100, 1000);
  sample(tracker, 105, 1001);
  tracker.forget();
  assert.deepEqual(tracker.series(1000, 1), [null]);
  assert.equal(tracker.lastWriteMs(), null);
  sample(tracker, 170000, 1002);
  assert.deepEqual(tracker.series(1002, 1), [null]);
  assert.equal(tracker.highestCount(), 170000);
});

test('last write starts from the newest row, then follows observed growth',
    () => {
      const tracker = createIngestTracker();
      assert.equal(tracker.lastWriteMs(), null);
      tracker.record({identity: IDENTITY, rowCount: 5, observedAtMs: 10000,
        newestCreatedAtMs: 4000});
      assert.equal(tracker.lastWriteMs(), 4000);
      // A retried row keeps its old created_at; growth is what proves a write.
      tracker.record({identity: IDENTITY, rowCount: 6, observedAtMs: 11000,
        newestCreatedAtMs: 4000});
      assert.equal(tracker.lastWriteMs(), 11000);
      tracker.record({identity: IDENTITY, rowCount: 6, observedAtMs: 12000,
        newestCreatedAtMs: 4000});
      assert.equal(tracker.lastWriteMs(), 11000);
    });

test('a writer clock ahead of the server cannot make last write negative',
    () => {
      const tracker = createIngestTracker();
      tracker.record({identity: IDENTITY, rowCount: 1, observedAtMs: 10000,
        newestCreatedAtMs: 99000});
      assert.equal(tracker.lastWriteMs(), 10000);
    });

test('the average weighs each second by how long it was observed', () => {
  const tracker = createIngestTracker();
  sample(tracker, 0, 1000);
  sample(tracker, 5, 1000.5);
  sample(tracker, 6, 1001.5);
  // 6 rows over 1.5 s; a plain mean of per-second rates would say 3.25.
  assert.equal(tracker.averageRate(1001, 10), 4);
});

test('old seconds are dropped, but never inside the 60 second chart', () => {
  const tracker = createIngestTracker();
  sample(tracker, 0, 1000);
  for (let second = 1; second <= 500; second++) {
    sample(tracker, second, 1000 + second);
  }
  assert.equal(tracker.series(1499, 60)[0], 1);
  assert.deepEqual(tracker.series(1200, 1), [null]);
});

test('the page is one document with its script inline', () => {
  const page = renderLivePage({
    appInfo: {environment: 'aws', region: 'r', version: 'a'.repeat(40)},
    databaseText: 'demo · 1건',
  });
  assert.equal(page.match(/<script/g).length, 1);
  assert.equal(page.match(/<\/script>/g).length, 1);
  assert.doesNotMatch(page, /src=|href=|@import/);
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(page, /aaaaaaa</);
  assert.doesNotMatch(page, /a{8}/);
});

/** Just enough DOM for the inline script: ids, text, classes, table rows. */
function fakeElement() {
  const classes = new Set();
  return {
    textContent: '', hidden: false, dataset: {}, children: [], title: '',
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute() {},
    addEventListener() {},
    append(child) { this.children.push(child); },
    insertBefore(child, before) {
      if (child.parent) child.remove();
      const at = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(at, 0, child);
      child.parent = this;
    },
    remove() {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    },
  };
}

/** Runs the page's real inline script against scripted poll responses. */
function openDashboard(responses) {
  const page = renderLivePage({
    appInfo: {environment: 'onprem', region: 'r', version: 'v'},
    databaseText: 'first paint',
  });
  const source = page.match(/<script type="module">([\s\S]*)<\/script>/)[1];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  let nextPoll;
  let renderNow;
  const context = {
    document: {
      getElementById: element, body: element('body'),
      createElement: fakeElement,
    },
    fetch: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return {status: next.status, json: async () => next.body};
    },
    AbortSignal,
    setTimeout: (callback) => { nextPoll = callback; },
    setInterval: (callback) => { renderNow = callback; },
  };
  vm.runInNewContext(source, context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    element,
    async poll() {
      await settle();
      renderNow();
    },
    async pollAgain() {
      nextPoll();
      await settle();
      renderNow();
    },
  };
}

function liveBody(overrides = {}) {
  return {
    environment: 'onprem', region: 'r', version: 'a'.repeat(40),
    database: {name: 'source', row_count: '1000'},
    recent: [{request_id_prefix: 'aaaaaaaa', run_id: '<b>x</b>', phase: 'p',
      created_at: '2026-11-06T00:00:00.000Z'}],
    writes_paused: false, observed_at: new Date().toISOString(), ...overrides,
  };
}

test('the inline script paints a live answer using browser globals only',
    async () => {
      const screen = openDashboard([{status: 200, body: liveBody()}]);
      await screen.poll();
      assert.equal(screen.element('environment').textContent, 'onprem');
      assert.equal(screen.element('body').dataset.environment, 'onprem');
      assert.equal(screen.element('version').textContent, 'aaaaaaa');
      assert.equal(screen.element('total').textContent, '1,000');
      assert.equal(screen.element('status').textContent, '실시간');
      assert.equal(screen.element('banner').hidden, true);
      const row = screen.element('rows').children[0];
      assert.equal(row.children[1].textContent, '<b>x</b>');
    });

test('writes_paused raises the banner, on a DB outage too', async () => {
  const outage = liveBody({database: null, recent: [], writes_paused: true,
    error: {code: 'DB_UNAVAILABLE', message: 'x'}});
  const screen = openDashboard([{status: 503, body: outage}]);
  await screen.poll();
  assert.equal(screen.element('banner').hidden, false);
  assert.match(screen.element('status').textContent, /^DB 응답 없음 \d+초$/);
  assert.match(renderLivePage({
    appInfo: {environment: 'e', region: 'r', version: 'v'}, databaseText: 'd',
  }), /전환 중 · 쓰기 일시 정지/);
});

test('a failed poll says no response and keeps the last data', async () => {
  const screen = openDashboard([{status: 200, body: liveBody()},
    new Error('network down')]);
  await screen.poll();
  await screen.pollAgain();
  assert.match(screen.element('status').textContent, /^응답 없음 \d+초$/);
  assert.equal(screen.element('body').classList.contains('stale'), true);
  assert.equal(screen.element('total').textContent, '1,000');
});

test('a gateway error page counts as no response, not a DB outage',
    async () => {
      const screen = openDashboard([{status: 502, body: {}}]);
      await screen.poll();
      assert.match(screen.element('status').textContent, /^응답 없음/);
    });

test('a new environment without a DB drops the old environment data',
    async () => {
      const outage = liveBody({environment: 'aws', database: null, recent: [],
        error: {code: 'DB_UNAVAILABLE', message: 'x'}});
      const screen = openDashboard([{status: 200, body: liveBody()},
        {status: 503, body: outage}]);
      await screen.poll();
      await screen.pollAgain();
      assert.equal(screen.element('environment').textContent, 'aws');
      assert.equal(screen.element('database').textContent, '—');
      assert.equal(screen.element('total').textContent, '—');
      assert.equal(screen.element('rows').children.length, 0);
      assert.equal(screen.element('rate').textContent, '—');
      assert.equal(screen.element('last-write').textContent, '—');
    });

test('the same environment keeps its last data through a DB outage',
    async () => {
      const outage = liveBody({database: null, recent: [],
        error: {code: 'DB_UNAVAILABLE', message: 'x'}});
      const screen = openDashboard([{status: 200, body: liveBody()},
        {status: 503, body: outage}]);
      await screen.poll();
      await screen.pollAgain();
      assert.equal(screen.element('total').textContent, '1,000');
      assert.equal(screen.element('rows').children.length, 1);
    });

test('status stays connecting until the first answer', async () => {
  const screen = openDashboard([]);
  assert.equal(screen.element('status').textContent, '');
});

test('a screen recovers from a DB outage without highlighting old rows',
    async () => {
      const later = new Date(Date.now() + 1000).toISOString();
      const outage = liveBody({database: null, recent: [],
        error: {code: 'DB_UNAVAILABLE', message: 'x'}});
      const screen = openDashboard([{status: 503, body: outage},
        {status: 200, body: liveBody({observed_at: later})}]);
      await screen.poll();
      await screen.pollAgain();
      assert.equal(screen.element('status').textContent, '실시간');
      assert.equal(screen.element('status').classList.contains('down'), false);
      assert.equal(screen.element('rows').children[0].classList
          .contains('fresh'), false);
    });

test('only a row arriving after the first answer is highlighted', async () => {
  const later = new Date(Date.now() + 1000).toISOString();
  const newRow = {request_id_prefix: 'bbbbbbbb', run_id: 'r', phase: 'p',
    created_at: '2026-11-06T00:00:01.000Z'};
  const first = liveBody();
  const screen = openDashboard([{status: 200, body: first},
    {status: 200, body: liveBody({observed_at: later,
      recent: [newRow, ...first.recent]})}]);
  await screen.poll();
  await screen.pollAgain();
  const [fresh, old] = screen.element('rows').children;
  assert.equal(fresh.children[0].textContent, 'bbbbbbbb');
  assert.equal(fresh.classList.contains('fresh'), true);
  assert.equal(old.classList.contains('fresh'), false);
});

test('rows sharing an ID prefix stay separate rows', async () => {
  const row = (second) => ({request_id_prefix: 'aaaaaaaa', run_id: 'r',
    phase: 'p', created_at: `2026-11-06T00:00:0${second}.000Z`});
  const screen = openDashboard([{status: 200,
    body: liveBody({recent: [row(2), row(1)]})}]);
  await screen.poll();
  assert.equal(screen.element('rows').children.length, 2);
});

test('an older answer from another replica does not rewind the list',
    async () => {
      const newest = {request_id_prefix: 'bbbbbbbb', run_id: 'r', phase: 'p',
        created_at: '2026-11-06T00:00:01.000Z'};
      const now = Date.now();
      const at = (ms) => new Date(now + ms).toISOString();
      const screen = openDashboard([
        {status: 200, body: liveBody({observed_at: at(1000),
          recent: [newest]})},
        {status: 200, body: liveBody({observed_at: at(0)})},
      ]);
      await screen.poll();
      await screen.pollAgain();
      assert.equal(screen.element('rows').children[0].children[0].textContent,
          'bbbbbbbb');
    });

test('replicas out of step never make the total go backwards', async () => {
  const later = (ms) => new Date(Date.now() + ms).toISOString();
  const screen = openDashboard([
    {status: 200, body: liveBody({
      database: {name: 'source', row_count: '105'}})},
    {status: 200, body: liveBody({observed_at: later(1000),
      database: {name: 'source', row_count: '103'}})},
  ]);
  await screen.poll();
  await screen.pollAgain();
  assert.equal(screen.element('total').textContent, '105');
});
