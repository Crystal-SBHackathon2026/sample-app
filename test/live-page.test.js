const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  createIngestTracker, createVersionTracker, renderLivePage, splitChartSegments,
  versionColor,
} = require('../src/live-page');

const IDENTITY = 'aws/demo';

const series = (tracker, endSecond, count) => tracker.bars(endSecond, count)
    .map((bar) => (bar ? bar.rate : null));

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
  assert.deepEqual(series(tracker, 1009, 3), [5, 5, 5]);
});

test('the first sample is a baseline, not a burst of ingest', () => {
  const tracker = createIngestTracker();
  sample(tracker, 170000, 1000);
  assert.equal(tracker.averageRate(1000, 10), null);
  assert.deepEqual(series(tracker, 1000, 2), [null, null]);
});

test('a gap spreads its growth by time and leaves older seconds unobserved',
    () => {
      const tracker = createIngestTracker();
      sample(tracker, 0, 1000);
      sample(tracker, 300, 1030);
      const rates = series(tracker, 1029, 30);
      assert.deepEqual(rates.slice(-3), [10, 10, 10]);
      assert.deepEqual(rates.slice(0, 27), new Array(27).fill(null));
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
  for (const rate of series(tracker, 1005, 4)) {
    assert.ok(Math.abs(rate - 5) < 0.3, String(rate));
  }
});

test('a sample with no growth is an observed zero, not a gap', () => {
  const tracker = createIngestTracker();
  sample(tracker, 10, 1000);
  sample(tracker, 10, 1001);
  assert.deepEqual(series(tracker, 1000, 1), [0]);
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
      assert.deepEqual(series(tracker, 1003, 4), [5, 0, 0, 1]);
    });

test('a cached or older sample is ignored', () => {
  const tracker = createIngestTracker();
  sample(tracker, 100, 1000);
  sample(tracker, 110, 1002);
  sample(tracker, 110, 1002);
  sample(tracker, 111, 1001);
  assert.deepEqual(series(tracker, 1001, 2), [5, 5]);
  sample(tracker, 115, 1003);
  assert.deepEqual(series(tracker, 1002, 1), [5]);
});

test('switching database is a new baseline, not a spike', () => {
  const tracker = createIngestTracker();
  sample(tracker, 100, 1000);
  sample(tracker, 101, 1001);
  sample(tracker, 170675, 1002, 'onprem/migration_demo_return');
  assert.deepEqual(series(tracker, 1001, 2), [1, null]);
  sample(tracker, 170676, 1003, 'onprem/migration_demo_return');
  assert.deepEqual(series(tracker, 1002, 1), [1]);
});

test('a database rebuilt under the same name is a new baseline', () => {
  const tracker = createIngestTracker();
  sample(tracker, 170000, 1000);
  assert.equal(tracker.record({identity: IDENTITY, rowCount: 3,
    observedAtMs: 1001000, newestCreatedAtMs: null}), 'baseline');
  assert.equal(tracker.highestCount(), 3);
});

test('the average never reaches back across a new baseline', () => {
  const tracker = createIngestTracker();
  sample(tracker, 100, 1000);
  sample(tracker, 110, 1001);
  sample(tracker, 5000, 1001.5, 'gcp/demo_gcp');
  assert.equal(tracker.averageRate(1001, 10), null);
  sample(tracker, 5002, 1002.5, 'gcp/demo_gcp');
  assert.equal(tracker.averageRate(1002, 10), 2);
  // The chart keeps the previous environment's seconds on purpose.
  assert.equal(series(tracker, 1000, 1)[0], 10);
});

test('a new environment with a slower clock inherits no previous seconds',
    () => {
      const tracker = createIngestTracker();
      sample(tracker, 100, 1000);
      sample(tracker, 200, 1001);
      sample(tracker, 300, 1002);
      // gcp's clock runs 1.5 s behind: its baseline predates aws's last rows.
      sample(tracker, 5000, 1000.5, 'gcp/demo_gcp');
      assert.equal(tracker.averageRate(1002, 10), null);
      sample(tracker, 5000, 1001.5, 'gcp/demo_gcp');
      sample(tracker, 5000, 1002.5, 'gcp/demo_gcp');
      assert.equal(tracker.averageRate(1002, 10), 0);
    });

test('each chart bar keeps the environment of its own second', () => {
  const tracker = createIngestTracker();
  const next = (environment, rowCount, seconds) => tracker.record({
    identity: `${environment}/db`, environment, rowCount,
    observedAtMs: seconds * 1000, newestCreatedAtMs: null,
  });
  next('aws', 100, 1000);
  next('aws', 150, 1001);
  next('gcp', 5000, 1004);
  next('gcp', 5002, 1005);
  assert.deepEqual(tracker.bars(1004, 5), [
    {rate: 50, environment: 'aws'}, null, null, null,
    {rate: 2, environment: 'gcp'},
  ]);
});

test('the peak counts the current environment only', () => {
  const tracker = createIngestTracker();
  const next = (environment, rowCount, seconds) => tracker.record({
    identity: `${environment}/db`, environment, rowCount,
    observedAtMs: seconds * 1000, newestCreatedAtMs: null,
  });
  next('aws', 100, 1000);
  next('aws', 150, 1001);
  next('gcp', 5000, 1002);
  assert.equal(tracker.peakRate(1002, 60), null);
  next('gcp', 5002, 1003);
  assert.equal(tracker.peakRate(1002, 60), 2);
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

test('forgetting drops the numbers; the next sample is a new baseline', () => {
  const tracker = createIngestTracker();
  sample(tracker, 100, 1000);
  sample(tracker, 105, 1001);
  tracker.forget();
  assert.equal(tracker.averageRate(1001, 10), null);
  assert.equal(tracker.peakRate(1001, 60), null);
  assert.equal(tracker.lastWriteMs(), null);
  // The bars still show who served when.
  assert.deepEqual(series(tracker, 1000, 1), [5]);
  sample(tracker, 170000, 1002);
  assert.deepEqual(series(tracker, 1002, 1), [null]);
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
  assert.equal(series(tracker, 1499, 60)[0], 1);
  assert.deepEqual(series(tracker, 1200, 1), [null]);
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
    style: {},
    replaceChildren(...children) { this.children = children; },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    attributes: {},
    setAttribute(name, value) {
      this.attributes = {...this.attributes, [name]: String(value)};
    },
    addEventListener() {},
    append(...children) { this.children.push(...children); },
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
      createElementNS: fakeElement,
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
      assert.equal(screen.element('version').children[0].textContent,
          'aaaaaaa');
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
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const screen = openDashboard([
    {status: 200, body: liveBody({observed_at: at(-1000)})},
    {status: 200, body: liveBody({observed_at: at(0),
      database: {name: 'source', row_count: '1000'}})},
    new Error('network down'),
  ]);
  await screen.poll();
  await screen.pollAgain();
  assert.equal(screen.element('rate').textContent, '0.0');
  await screen.pollAgain();
  assert.match(screen.element('status').textContent, /^응답 없음 \d+초$/);
  assert.equal(screen.element('body').classList.contains('stale'), true);
  assert.equal(screen.element('rate').textContent, '—');
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
      const now = Date.now();
      const at = (ms) => new Date(now + ms).toISOString();
      const outage = liveBody({database: null, recent: [],
        error: {code: 'DB_UNAVAILABLE', message: 'x'}});
      const screen = openDashboard([
        {status: 200, body: liveBody({observed_at: at(-1000)})},
        {status: 200, body: liveBody({observed_at: at(0)})},
        {status: 503, body: outage},
      ]);
      await screen.poll();
      await screen.pollAgain();
      assert.equal(screen.element('rate').textContent, '0.0');
      await screen.pollAgain();
      assert.equal(screen.element('total').textContent, '1,000');
      assert.equal(screen.element('rows').children.length, 1);
      assert.equal(screen.element('rate').textContent, '—');
    });

test('a new environment without a DB keeps the bars of the old one',
    async () => {
      const now = Date.now();
      const at = (ms) => new Date(now + ms).toISOString();
      const aws = (rows, ms) => liveBody({environment: 'aws',
        observed_at: at(ms), database: {name: 'db', row_count: String(rows)}});
      const screen = openDashboard([
        {status: 200, body: aws(100, -3000)},
        {status: 200, body: aws(110, -2000)},
        {status: 200, body: aws(120, -1000)},
        {status: 200, body: aws(130, 0)},
        {status: 503, body: liveBody({environment: 'gcp', database: null,
          recent: [], error: {code: 'DB_UNAVAILABLE', message: 'x'}})},
      ]);
      await screen.poll();
      for (let poll = 0; poll < 4; poll++) await screen.pollAgain();
      const segments = screen.element('sparkline-segments').children;
      assert.ok(segments.length >= 1);
      assert.ok(segments.every((segment) =>
        segment.attributes['data-environment'] === 'aws'));
      assert.equal(screen.element('rate').textContent, '—');
      assert.equal(screen.element('sparkline-peak').textContent, '');
    });

test('environment colors beat the default bar color', () => {
  const page = renderLivePage({
    appInfo: {environment: 'e', region: 'r', version: 'v'}, databaseText: 'd',
  });
  // A selector with a class or id would outrank [data-environment] and gray out
  // every segment.
  assert.match(page, /^g \{ --environment:/m);
  assert.doesNotMatch(page, /[.#][\w-]+ g \{/);
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

test('aws to gcp leaves no aws number on the gcp screen', async () => {
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const aws = (rows, ms) => liveBody({environment: 'aws', observed_at: at(ms),
    database: {name: 'demo_aws', row_count: String(rows)}});
  const gcpRow = {request_id_prefix: 'cccccccc', run_id: 'gcp_seed',
    phase: 'gcp_live', created_at: at(-60000)};
  const screen = openDashboard([
    {status: 200, body: aws(170000, -3000)},
    {status: 200, body: aws(170010, -2000)},
    {status: 200, body: aws(170020, -1000)},
    {status: 200, body: liveBody({environment: 'gcp', observed_at: at(0),
      database: {name: 'demo_gcp', row_count: '5000'}, recent: [gcpRow]})},
  ]);
  await screen.poll();
  await screen.pollAgain();
  await screen.pollAgain();
  assert.equal(screen.element('rate').textContent, '10.0');
  await screen.pollAgain();
  assert.equal(screen.element('environment').textContent, 'gcp');
  assert.equal(screen.element('body').dataset.environment, 'gcp');
  assert.equal(screen.element('database').textContent, 'demo_gcp');
  assert.equal(screen.element('total').textContent, '5,000');
  assert.equal(screen.element('rate').textContent, '—');
  assert.ok(Number(screen.element('last-write').textContent) >= 59);
  const rows = screen.element('rows').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[1].textContent, 'gcp_seed');
  assert.equal(rows[0].classList.contains('fresh'), false);
});

test('bars are colored by their own environment, gaps stay empty',
    async () => {
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const body = (environment, rows, ms) => liveBody({environment,
    observed_at: at(ms), database: {name: 'db', row_count: String(rows)}});
  const screen = openDashboard([
    {status: 200, body: body('aws', 100, -11000)},
    {status: 200, body: body('aws', 200, -10000)},
    {status: 200, body: body('gcp', 5000, -5000)},
    {status: 200, body: body('gcp', 5003, -4000)},
    {status: 200, body: body('gcp', 5006, -3000)},
    {status: 200, body: body('gcp', 5009, -2000)},
    {status: 200, body: body('gcp', 5012, -1000)},
    {status: 200, body: body('gcp', 5015, 0)},
  ]);
  await screen.poll();
  for (let poll = 0; poll < 7; poll++) await screen.pollAgain();
  const segments = screen.element('sparkline-segments').children;
  assert.deepEqual(segments.map((one) => one.attributes['data-environment']),
      ['aws', 'gcp']);
  // Each environment gets its own filled area and line, so a gap stays empty.
  assert.deepEqual(segments[0].children.map((path) => path.attributes.class),
      ['chart-area', 'chart-line']);
  assert.equal(screen.element('sparkline-peak').textContent, '최대 3.0/초');
});

test('an observed zero stays visible, unlike an unobserved second',
    async () => {
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const screen = openDashboard([
    {status: 200, body: liveBody({observed_at: at(-3000)})},
    {status: 200, body: liveBody({observed_at: at(-2000)})},
    {status: 200, body: liveBody({observed_at: at(-1000)})},
    {status: 200, body: liveBody({observed_at: at(0)})},
  ]);
  await screen.poll();
  for (let poll = 0; poll < 3; poll++) await screen.pollAgain();
  const [segment] = screen.element('sparkline-segments').children;
  // A line along the bottom of the chart, unlike an unobserved second.
  assert.match(segment.children[1].attributes.d, / 120/);
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

const versionAnswers = (tracker, versions, startMs = 0) => {
  versions.forEach((version, index) => {
    tracker.record(version, startMs + index * 1000);
  });
};

test('a plain replacement switches once and is never called a mix', () => {
  const tracker = createVersionTracker();
  versionAnswers(tracker, ['a', 'a', 'b', 'b', 'b']);
  // Held back until confirmed: this could still be the first canary answer.
  assert.deepEqual(tracker.shares(), [{version: 'a', percent: 100}]);
  tracker.record('b', 5000);
  assert.deepEqual(tracker.shares(), [{version: 'b', percent: 100}]);
  assert.deepEqual(tracker.recentChange(5000),
      {from: 'a', to: 'b', atMs: 5000});
  assert.equal(tracker.recentChange(8000), null);
  assert.equal(tracker.marks().length, 1);
});

test('alternating versions show shares, then one version once it is alone',
    () => {
      const tracker = createVersionTracker();
      versionAnswers(tracker, ['a', 'b', 'a', 'b', 'a', 'b']);
      assert.deepEqual(tracker.shares(), [
        {version: 'a', percent: 50}, {version: 'b', percent: 50},
      ]);
      assert.equal(tracker.marks().length, 0);
      versionAnswers(tracker, new Array(11).fill('b'), 6000);
      assert.deepEqual(tracker.shares(), [{version: 'b', percent: 100}]);
      assert.deepEqual(tracker.marks().map((mark) => mark.version), ['b']);
    });

test('another deployment starts over instead of announcing a change', () => {
  const tracker = createVersionTracker();
  versionAnswers(tracker, ['a', 'a']);
  tracker.reset();
  tracker.record('b', 2000);
  assert.deepEqual(tracker.shares(), [{version: 'b', percent: 100}]);
  assert.equal(tracker.recentChange(2000), null);
});

test('a version keeps its color and never takes an environment color', () => {
  // Pinned: the demo viewer copies this function and must agree with it.
  assert.equal(versionColor('d697a40'), '#a3e635');
  assert.equal(versionColor('a1b2c3d'), '#f472b6');
  const environmentColors = ['#2dd4bf', '#ff9900', '#60a5fa', '#9aa7b4'];
  for (let index = 0; index < 200; index++) {
    assert.ok(!environmentColors.includes(versionColor(`v${index}`)));
  }
});

test('chart segments end at a gap and at a change of environment', () => {
  const bar = (environment, rate) => ({environment, rate});
  assert.deepEqual(splitChartSegments([
    null, bar('aws', 1), bar('aws', 2), null, bar('gcp', 3), bar('aws', 4),
  ]), [
    {environment: 'aws', firstIndex: 1, rates: [1, 2]},
    {environment: 'gcp', firstIndex: 4, rates: [3]},
    {environment: 'aws', firstIndex: 5, rates: [4]},
  ]);
});

test('the rate falls to 0.0 at once while the pause banner is up', async () => {
  const now = Date.now();
  const at = (ms) => new Date(now + ms).toISOString();
  const body = (rows, ms, paused) => liveBody({observed_at: at(ms),
    writes_paused: paused, database: {name: 'db', row_count: String(rows)}});
  const screen = openDashboard([
    {status: 200, body: body(100, -1000, false)},
    {status: 200, body: body(110, 0, false)},
    {status: 200, body: body(110, 500, true)},
  ]);
  await screen.poll();
  await screen.pollAgain();
  assert.equal(screen.element('rate').textContent, '10.0');
  await screen.pollAgain();
  assert.equal(screen.element('banner').hidden, false);
  assert.equal(screen.element('rate').textContent, '0.0');
});

test('a version change raises the notice and marks the chart', async () => {
  const answer = (version) => ({status: 200, body: liveBody({version})});
  const screen = openDashboard([
    answer('old'), answer('new'), answer('new'), answer('new'), answer('new'),
  ]);
  await screen.poll();
  for (let poll = 0; poll < 4; poll++) await screen.pollAgain();
  assert.equal(screen.element('version-notice').hidden, false);
  assert.equal(screen.element('version-notice').textContent,
      '버전 변경 old → new');
  assert.equal(screen.element('version').classList.contains('changed'), true);
  assert.equal(screen.element('version').children[0].textContent, 'new');
});

test('a canary shows each version with its share', async () => {
  const answer = (version) => ({status: 200, body: liveBody({version})});
  const screen = openDashboard(
      ['old', 'new', 'old', 'new'].map(answer));
  await screen.poll();
  for (let poll = 0; poll < 3; poll++) await screen.pollAgain();
  assert.deepEqual(
      screen.element('version').children.map((chip) => chip.textContent),
      ['new 50%', 'old 50%']);
});
