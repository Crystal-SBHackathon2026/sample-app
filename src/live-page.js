const FULL_COMMIT_LENGTH = 40;
const SHORT_COMMIT_LENGTH = 7;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function shortVersion(version) {
  return version.length === FULL_COMMIT_LENGTH ?
      version.slice(0, SHORT_COMMIT_LENGTH) : version;
}

/*
 * createIngestTracker and runDashboard run in the browser: renderLivePage
 * inlines their source. They may only reference browser globals and each
 * other, and their source must never contain a closing script tag.
 */

/**
 * Turns successive row counts into rows per second. Counts only grow in this
 * insert-only table, so growth is measured against the highest count seen:
 * replicas answering out of step cannot inflate it.
 */
function createIngestTracker() {
  const MAX_FILLED_MILLIS = 3000;
  const REBUILT_DATABASE_RATIO = 0.9;
  const RETAINED_SECONDS = 120;
  const observedBySecond = new Map();
  let identity = null;
  let highestCount = 0;
  let lastObservedMs = 0;
  let lastWriteMs = null;
  let baselineSecond = 0;

  function startBaseline(sample) {
    identity = sample.identity;
    highestCount = sample.rowCount;
    lastObservedMs = sample.observedAtMs;
    lastWriteMs = sample.newestCreatedAtMs === null ? null :
        Math.min(sample.newestCreatedAtMs, sample.observedAtMs);
    // Seconds from here on may hold rows of the previous deployment, whose
    // clock can run ahead of this one.
    baselineSecond = Math.floor(sample.observedAtMs / 1000);
    for (const second of observedBySecond.keys()) {
      if (second >= baselineSecond) observedBySecond.delete(second);
    }
  }

  /**
   * Credits each second with its share of the interval's rows and with the
   * time observed, so a rate stays true however samples fall across seconds.
   * Only the newest part is credited: a long gap stays visibly unobserved
   * instead of being painted over with an average nobody measured.
   */
  function recordGrowth(growth, observedAtMs, environment) {
    const rowsPerMilli = growth / (observedAtMs - lastObservedMs);
    let from = Math.max(lastObservedMs, observedAtMs - MAX_FILLED_MILLIS);
    while (from < observedAtMs) {
      const second = Math.floor(from / 1000);
      const until = Math.min((second + 1) * 1000, observedAtMs);
      const bucket = observedBySecond.get(second) ||
          {rows: 0, millis: 0, environment};
      bucket.rows += rowsPerMilli * (until - from);
      bucket.millis += until - from;
      observedBySecond.set(second, bucket);
      from = until;
    }
    const oldest = Math.floor(observedAtMs / 1000) - RETAINED_SECONDS;
    for (const second of observedBySecond.keys()) {
      if (second < oldest) observedBySecond.delete(second);
    }
  }

  function buckets(endSecond, count) {
    return Array.from({length: count}, (unused, index) =>
      observedBySecond.get(endSecond - count + 1 + index));
  }

  const rateOf = (bucket) => bucket.rows * 1000 / bucket.millis;

  /** Observed buckets of the current deployment within the last seconds. */
  function bucketsSinceBaseline(endSecond, seconds) {
    const sinceBaseline = endSecond - baselineSecond + 1;
    const window = Math.max(0, Math.min(seconds, sinceBaseline));
    return buckets(endSecond, window).filter(Boolean);
  }

  return {
    /** Returns 'baseline', 'newer', or 'stale' for a sample to be ignored. */
    record(sample) {
      if (sample.identity !== identity) {
        startBaseline(sample);
        return 'baseline';
      }
      if (sample.observedAtMs <= lastObservedMs) return 'stale';
      // Replica lag is a few rows; a large fall means the database was rebuilt.
      if (sample.rowCount < highestCount * REBUILT_DATABASE_RATIO) {
        startBaseline(sample);
        return 'baseline';
      }
      const growth = Math.max(0, sample.rowCount - highestCount);
      recordGrowth(growth, sample.observedAtMs, sample.environment);
      highestCount = Math.max(highestCount, sample.rowCount);
      lastObservedMs = sample.observedAtMs;
      if (growth > 0) lastWriteMs = sample.observedAtMs;
      return 'newer';
    },
    /**
     * Drops the numbers of a deployment that was replaced by one whose rows
     * cannot be read yet. The chart keeps its bars: they show who served when.
     */
    forget() {
      identity = null;
      highestCount = 0;
      lastWriteMs = null;
      baselineSecond = Infinity;
    },
    /** Rates up to endSecond with their environment; null means unobserved. */
    bars(endSecond, count) {
      return buckets(endSecond, count).map((bucket) => (bucket ?
        {rate: rateOf(bucket), environment: bucket.environment} : null));
    },
    /** Highest rate of the current deployment; null when nothing observed. */
    peakRate(endSecond, seconds) {
      const observed = bucketsSinceBaseline(endSecond, seconds);
      return observed.length === 0 ? null : Math.max(...observed.map(rateOf));
    },
    /**
     * Rows per second over observed time since the last baseline, so a number
     * from the previous deployment never shows under the new one. Null when
     * nothing was observed.
     */
    averageRate(endSecond, seconds) {
      const observed = bucketsSinceBaseline(endSecond, seconds);
      if (observed.length === 0) return null;
      const rows = observed.reduce((sum, bucket) => sum + bucket.rows, 0);
      const millis = observed.reduce((sum, bucket) => sum + bucket.millis, 0);
      return rows * 1000 / millis;
    },
    highestCount() { return highestCount; },
    lastWriteMs() { return lastWriteMs; },
  };
}

/**
 * Tells what versions are answering: one, or a canary mix. A plain replacement
 * flips once and stays, so it never counts as a mix; only versions alternating
 * within the window do. A new version must answer a few times in a row first,
 * or the first canary answer would read as a finished replacement.
 */
function createVersionTracker() {
  const WINDOW_MILLIS = 10000;
  const CHANGE_NOTICE_MILLIS = 3000;
  const ANSWERS_TO_CONFIRM = 4;
  const RETAINED_MARKS = 20;
  let answers = [];
  let current = null;
  let change = null;
  const marks = [];

  const flips = () => answers.filter((answer, index) =>
    index > 0 && answer.version !== answers[index - 1].version).length;

  function trailingRun() {
    const newest = answers[answers.length - 1].version;
    let run = 0;
    for (let i = answers.length - 1; i >= 0; i--) {
      if (answers[i].version !== newest) break;
      run++;
    }
    return run;
  }

  return {
    record(version, atMs) {
      answers.push({version, atMs});
      answers = answers.filter((answer) => atMs - answer.atMs < WINDOW_MILLIS);
      const settled = flips() === 0 ||
          (flips() === 1 && trailingRun() >= ANSWERS_TO_CONFIRM);
      if (!settled || version === current) return;
      if (current !== null) {
        change = {from: current, to: version, atMs};
        marks.push({version, atMs});
        marks.splice(0, Math.max(0, marks.length - RETAINED_MARKS));
      }
      current = version;
    },
    /** Starts over for another deployment; its version is not a change. */
    reset() {
      answers = [];
      current = null;
      change = null;
    },
    /** Versions to show with their share of recent answers, largest first. */
    shares() {
      if (flips() < 2) return current ? [{version: current, percent: 100}] : [];
      const counts = new Map();
      for (const {version} of answers) {
        counts.set(version, (counts.get(version) || 0) + 1);
      }
      return [...counts]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([version, count]) => ({
            version, percent: Math.round(count * 100 / answers.length),
          }));
    },
    /** The change to announce right now, or null. */
    recentChange(nowMs) {
      return change && nowMs - change.atMs < CHANGE_NOTICE_MILLIS ?
          change : null;
    },
    marks() { return marks; },
  };
}

/**
 * Picks a version's color from its hash alone, so one version looks the same
 * on every screen. None is close to an environment color.
 */
function versionColor(version) {
  const COLORS = [
    '#c084fc', '#f472b6', '#a3e635', '#fde047', '#f5f5f4', '#c4a484',
  ];
  let hash = 2166136261;
  for (let index = 0; index < version.length; index++) {
    hash = Math.imul(hash ^ version.charCodeAt(index), 16777619) >>> 0;
  }
  return COLORS[hash % COLORS.length];
}

/** Splits chart bars into runs of one environment; a gap ends a run too. */
function splitChartSegments(bars) {
  const segments = [];
  let open = null;
  bars.forEach((bar, index) => {
    if (!bar) {
      open = null;
      return;
    }
    if (!open || open.environment !== bar.environment) {
      open = {environment: bar.environment, firstIndex: index, rates: []};
      segments.push(open);
    }
    open.rates.push(bar.rate);
  });
  return segments;
}

function runDashboard() {
  const POLL_MILLIS = 1000;
  const POLL_TIMEOUT_MILLIS = 3000;
  const RENDER_MILLIS = 250;
  const RATE_WINDOW_SECONDS = 10;
  const CHART_SECONDS = 60;
  // Samples arrive up to two seconds late; keep them off the chart's edge.
  const CHART_LAG_SECONDS = 2;
  const CHART_WIDTH = 600;
  const CHART_HEIGHT = 120;
  const CHART_TOP_MARGIN = 4;
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const FULL_COMMIT_CHARACTERS = 40;
  const SHORT_COMMIT_CHARACTERS = 7;

  const element = (id) => document.getElementById(id);
  const tracker = createIngestTracker();
  const versions = createVersionTracker();
  const rowsById = new Map();
  let serverClockOffsetMs = -Infinity;
  let lastAnswerMs = Date.now();
  let lastDatabaseMs = Date.now();
  let appAnswering = null;
  let databaseAnswering = true;
  let shownEnvironment = null;
  let writesPaused = false;
  let shownShares = '';

  const shortVersion = (version) => (
    version.length === FULL_COMMIT_CHARACTERS ?
    version.slice(0, SHORT_COMMIT_CHARACTERS) : version);

  const serverNowMs = () => Date.now() +
      (serverClockOffsetMs === -Infinity ? 0 : serverClockOffsetMs);

  function renderIdentity(live) {
    document.body.dataset.environment = live.environment;
    element('environment').textContent = live.environment;
    element('region').textContent = live.region;
    if (live.environment !== shownEnvironment) versions.reset();
    versions.record(live.version, Date.now());
    writesPaused = live.writes_paused;
    element('banner').hidden = !live.writes_paused;
  }

  function createVersionChip({version, percent}) {
    const chip = document.createElement('span');
    chip.className = 'version-chip';
    chip.style.background = versionColor(version);
    chip.textContent = percent === 100 ? shortVersion(version) :
        `${shortVersion(version)} ${percent}%`;
    return chip;
  }

  function renderVersion() {
    const shares = versions.shares();
    const key = JSON.stringify(shares);
    if (shares.length > 0 && key !== shownShares) {
      shownShares = key;
      element('version').replaceChildren(...shares.map(createVersionChip));
    }
    const change = versions.recentChange(Date.now());
    element('version').classList.toggle('changed', change !== null);
    element('version-notice').hidden = change === null;
    if (change) {
      element('version-notice').textContent =
          `버전 변경 ${shortVersion(change.from)} → ${shortVersion(change.to)}`;
    }
  }

  function createRow(row) {
    const tableRow = document.createElement('tr');
    const time = new Date(row.created_at).toLocaleTimeString('en-GB');
    // run_id and phase are request input: textContent keeps them inert.
    for (const text of [row.request_id_prefix, row.run_id, row.phase, time]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      cell.title = text;
      tableRow.append(cell);
    }
    tableRow.addEventListener('animationend',
        () => tableRow.classList.remove('fresh'));
    return tableRow;
  }

  // The ID prefix alone is not unique: a UUIDv7 keeps it for about a minute.
  const rowKey = (row) =>
    [row.request_id_prefix, row.created_at, row.run_id, row.phase].join('|');

  function renderRows(recent, highlightNew) {
    const body = element('rows');
    const current = new Set(recent.map(rowKey));
    for (const [id, tableRow] of rowsById) {
      if (!current.has(id)) {
        tableRow.remove();
        rowsById.delete(id);
      }
    }
    recent.forEach((row, index) => {
      let tableRow = rowsById.get(rowKey(row));
      if (!tableRow) {
        tableRow = createRow(row);
        if (highlightNew) tableRow.classList.add('fresh');
        rowsById.set(rowKey(row), tableRow);
      }
      // Rows already in place stay put, so their highlight is not restarted.
      if (body.children[index] !== tableRow) {
        body.insertBefore(tableRow, body.children[index] || null);
      }
    });
  }

  function applyLive(live) {
    lastDatabaseMs = Date.now();
    databaseAnswering = true;
    const observedAtMs = Date.parse(live.observed_at);
    const newest = live.recent[0];
    const outcome = tracker.record({
      identity: `${live.environment}/${live.database.name}`,
      environment: live.environment,
      rowCount: Number(live.database.row_count),
      observedAtMs,
      newestCreatedAtMs: newest ? Date.parse(newest.created_at) : null,
    });
    // Another replica's older answer must not rewind the screen.
    if (outcome === 'stale') return;
    const isBaseline = outcome === 'baseline';
    serverClockOffsetMs = Math.max(
        isBaseline ? -Infinity : serverClockOffsetMs,
        observedAtMs - Date.now());
    element('database').textContent = live.database.name;
    element('total').textContent =
        tracker.highestCount().toLocaleString('ko-KR');
    renderRows(live.recent, !isBaseline);
  }

  /** A new deployment without a DB must not show the old one's data. */
  function clearDatabaseIfOtherEnvironment(live) {
    if (live.environment === shownEnvironment) return;
    element('database').textContent = '—';
    element('total').textContent = '—';
    renderRows([], false);
    tracker.forget();
  }

  async function poll() {
    const startedMs = Date.now();
    try {
      const response = await fetch('/api/live', {
        cache: 'no-store', signal: AbortSignal.timeout(POLL_TIMEOUT_MILLIS),
      });
      const live = await response.json();
      if (response.status === 200) {
        applyLive(live);
      } else if (response.status === 503 && live.error) {
        databaseAnswering = false;
        clearDatabaseIfOtherEnvironment(live);
      } else {
        throw new Error('Unexpected response');
      }
      renderIdentity(live);
      shownEnvironment = live.environment;
      lastAnswerMs = Date.now();
      appAnswering = true;
    } catch {
      appAnswering = false;
    }
    setTimeout(poll, Math.max(0, POLL_MILLIS - (Date.now() - startedMs)));
  }

  function createChartPath(className, path) {
    const shape = document.createElementNS(SVG_NAMESPACE, 'path');
    shape.setAttribute('class', className);
    shape.setAttribute('d', path);
    return shape;
  }

  /** Draws one environment's run as a line over a filled area. */
  function createChartSegment({environment, firstIndex, rates}, largest) {
    const step = CHART_WIDTH / (CHART_SECONDS - 1);
    const xAt = (offset) => (firstIndex + offset) * step;
    const yAt = (rate) => CHART_HEIGHT -
        rate / largest * (CHART_HEIGHT - CHART_TOP_MARGIN);
    let line = rates.map((rate, offset) =>
      `${offset === 0 ? 'M' : 'L'}${xAt(offset)} ${yAt(rate)}`).join('');
    // A lone observed second still needs width to be visible.
    if (rates.length === 1) line += `h${step}`;
    const endX = xAt(Math.max(1, rates.length - 1));
    const area = `${line}L${endX} ${CHART_HEIGHT}` +
        `L${xAt(0)} ${CHART_HEIGHT}Z`;
    const group = document.createElementNS(SVG_NAMESPACE, 'g');
    group.setAttribute('data-environment', environment);
    group.append(createChartPath('chart-area', area),
        createChartPath('chart-line', line));
    return group;
  }

  /** Draws a vertical line at each version change still on the chart. */
  function renderVersionMarks(endSecond) {
    const step = CHART_WIDTH / (CHART_SECONDS - 1);
    const offsetMs = serverNowMs() - Date.now();
    const lines = [];
    for (const {version, atMs} of versions.marks()) {
      const second = Math.floor((atMs + offsetMs) / 1000);
      const index = second - (endSecond - CHART_SECONDS + 1);
      if (index < 0 || index >= CHART_SECONDS) continue;
      const line = document.createElementNS(SVG_NAMESPACE, 'line');
      line.setAttribute('class', 'version-mark');
      line.setAttribute('x1', index * step);
      line.setAttribute('x2', index * step);
      line.setAttribute('y1', 0);
      line.setAttribute('y2', CHART_HEIGHT);
      line.setAttribute('stroke', versionColor(version));
      lines.push(line);
    }
    element('sparkline-marks').replaceChildren(...lines);
  }

  function renderChart(nowSecond) {
    const endSecond = nowSecond - CHART_LAG_SECONDS;
    const bars = tracker.bars(endSecond, CHART_SECONDS);
    const rates = bars.filter(Boolean).map((bar) => bar.rate);
    // The axis fits all it shows; its floor keeps a trickle from filling it.
    const largest = Math.max(1, ...rates);
    element('sparkline-segments').replaceChildren(
        ...splitChartSegments(bars).map((segment) =>
          createChartSegment(segment, largest)));
    renderVersionMarks(endSecond);
    const peak = tracker.peakRate(endSecond, CHART_SECONDS);
    element('sparkline-peak').textContent = peak === null ? '' :
        `최대 ${peak.toFixed(peak < 10 ? 1 : 0)}/초`;
  }

  function renderStatus(nowMs) {
    if (appAnswering === null) return;
    const status = element('status');
    const secondsSince = (ms) => Math.floor((nowMs - ms) / 1000);
    document.body.classList.toggle('stale', !appAnswering);
    status.classList.toggle('down', !appAnswering || !databaseAnswering);
    if (!appAnswering) {
      status.textContent = `응답 없음 ${secondsSince(lastAnswerMs)}초`;
    } else if (!databaseAnswering) {
      status.textContent = `DB 응답 없음 ${secondsSince(lastDatabaseMs)}초`;
    } else {
      status.textContent = '실시간';
    }
  }

  function render() {
    const nowMs = serverNowMs();
    const nowSecond = Math.floor(nowMs / 1000);
    if (appAnswering !== false && writesPaused) {
      // The banner says writes stopped; a fading average would contradict it.
      element('rate').textContent = '0.0';
    } else {
      // Nothing is being measured during an outage, so no rate is claimed.
      const measuring = appAnswering !== false && databaseAnswering;
      const rate = measuring ?
          tracker.averageRate(nowSecond, RATE_WINDOW_SECONDS) : null;
      element('rate').textContent = rate === null ? '—' : rate.toFixed(1);
    }
    const lastWrite = tracker.lastWriteMs();
    element('last-write').textContent = lastWrite === null ? '—' :
        String(Math.max(0, Math.floor((nowMs - lastWrite) / 1000)));
    renderChart(nowSecond);
    renderVersion();
    renderStatus(Date.now());
  }

  poll();
  render();
  setInterval(render, RENDER_MILLIS);
}

const STYLE = `
:root {
  color-scheme: dark;
  --surface: #0b0f14; --panel: #151b23; --line: #2a333f;
  --text: #e6edf3; --muted: #9aa7b4; --alert: #ff6b6b;
  --environment: #9aa7b4;
}
[data-environment="onprem"] { --environment: #2dd4bf; }
[data-environment="aws"] { --environment: #ff9900; }
[data-environment="gcp"] { --environment: #60a5fa; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: flex; flex-direction: column; gap: 1.2vw; padding: 1.5vw;
  background: var(--surface); color: var(--text);
  font: clamp(16px, 1.3vw, 32px)/1.3 system-ui, "Apple SD Gothic Neo",
      "Noto Sans KR", sans-serif;
  font-variant-numeric: tabular-nums;
}
#banner {
  padding: .4em 1em; border-radius: 8px; background: #ffb020; color: #1a1205;
  font-size: clamp(22px, 2.6vw, 64px); font-weight: 800; text-align: center;
}
header {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: .2em 1.5vw;
}
h1 {
  margin: 0; color: var(--environment); font-size: clamp(56px, 9vw, 220px);
  font-weight: 900; line-height: 1; text-transform: uppercase;
  overflow-wrap: anywhere;
}
body.stale h1 { opacity: .35; }
#identity { color: var(--muted); font-size: clamp(16px, 1.6vw, 40px); }
#identity b { color: var(--text); }
#status {
  margin-left: auto; padding: .15em .6em; border-radius: 8px;
  color: var(--muted); font-size: clamp(20px, 2.4vw, 60px); font-weight: 800;
}
#status.down { background: var(--alert); color: #1f0505; }
main {
  flex: 1; min-height: 0; display: grid; gap: 1.2vw;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
}
#left { display: flex; flex-direction: column; gap: 1.2vw; min-width: 0; }
#counters {
  display: grid; gap: 1.2vw;
  grid-template-columns: minmax(0, 1.7fr) repeat(2, minmax(0, 1fr));
}
.panel {
  padding: 1vw 1.2vw; border: 1px solid var(--line); border-radius: 12px;
  background: var(--panel); min-width: 0;
}
.label { color: var(--muted); font-size: clamp(14px, 1.2vw, 30px); }
.value {
  font-size: clamp(30px, 3.3vw, 90px); font-weight: 800; line-height: 1.15;
  white-space: nowrap;
}
.unit { color: var(--muted); font-size: .4em; font-weight: 600; }
#chart { flex: 1; display: flex; flex-direction: column; min-height: 160px; }
#chart-heading { display: flex; justify-content: space-between; }
#chart svg { flex: 1; width: 100%; min-height: 0; margin-top: .4em; }
g { --environment: #9aa7b4; }
.chart-area { fill: var(--environment); fill-opacity: .18; }
.chart-line {
  fill: none; stroke: var(--environment); stroke-width: 2;
  stroke-linejoin: round; vector-effect: non-scaling-stroke;
}
.version-mark {
  stroke-width: 2; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke;
}
#version { display: inline-flex; flex-wrap: wrap; gap: .3em; }
.version-chip {
  padding: 0 .4em; border-radius: 4px; color: #0b0f14; font-weight: 800;
}
#version.changed { outline: .15em solid var(--text); border-radius: 6px; }
#version-notice {
  padding: .2em 1em; border-radius: 8px; background: var(--panel);
  border: 1px solid var(--text); font-size: clamp(18px, 2vw, 48px);
  font-weight: 800; text-align: center;
}
#sparkline-baseline {
  stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke;
}
#list { overflow: hidden; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th {
  color: var(--muted); font-size: clamp(14px, 1.1vw, 28px); font-weight: 600;
  text-align: left;
}
td {
  padding: .08em .4em .08em 0; border-top: 1px solid var(--line);
  font-size: clamp(15px, 1.25vw, 32px);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
th:nth-child(1), th:nth-child(4) { width: 22%; }
tr.fresh { animation: arrive 1.6s ease-out; }
@keyframes arrive {
  from { background: color-mix(in srgb, var(--environment) 45%, transparent); }
  to { background: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  tr.fresh { animation-duration: 1ms; }
}
@media (max-width: 900px) {
  html, body { height: auto; }
  body { padding: 16px; gap: 12px; }
  main { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  #left, #counters { gap: 12px; }
  #counters { grid-template-columns: minmax(0, 1fr); }
  .panel { padding: 12px; }
  #status { margin-left: 0; }
  #chart svg { height: 140px; flex: none; }
}
`;

/** Renders the dashboard; the first paint already names the deployment. */
function renderLivePage({appInfo, databaseText}) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ghost Migration Demo</title><style>${STYLE}</style></head>
<body data-environment="${escapeHtml(appInfo.environment)}">
  <div id="banner" role="status" hidden>⚠ 전환 중 · 쓰기 일시 정지</div>
  <div id="version-notice" role="status" hidden></div>
  <header>
    <h1 id="environment">${escapeHtml(appInfo.environment)}</h1>
    <div id="identity">
      <div>리전 <b id="region">${escapeHtml(appInfo.region)}</b>
        · 버전 <b id="version">${escapeHtml(shortVersion(appInfo.version))}</b>
      </div>
      <div>DB <b id="database">${escapeHtml(databaseText)}</b></div>
    </div>
    <div id="status" role="status">연결 중</div>
  </header>
  <main>
    <div id="left">
      <div id="counters">
        <div class="panel"><div class="label">총 행 수</div>
          <div class="value" id="total">—</div></div>
        <div class="panel"><div class="label">초당 유입(10초)</div>
          <div class="value"><span id="rate">—</span>
            <span class="unit">건/초</span></div></div>
        <div class="panel"><div class="label">마지막 쓰기 후</div>
          <div class="value"><span id="last-write">—</span>
            <span class="unit">초</span></div></div>
      </div>
      <div class="panel" id="chart">
        <div id="chart-heading"><span class="label">최근 60초 유입</span>
          <span class="label" id="sparkline-peak"></span></div>
        <svg viewBox="0 0 600 120" preserveAspectRatio="none" role="img"
            aria-label="최근 60초 초당 유입량. 끊긴 구간은 비어 있음">
          <line id="sparkline-baseline" x1="0" y1="120" x2="600" y2="120"/>
          <g id="sparkline-segments"></g><g id="sparkline-marks"></g>
        </svg>
      </div>
    </div>
    <div class="panel" id="list">
      <table><thead><tr><th>요청 ID</th><th>run_id</th><th>phase</th>
        <th>시각</th></tr></thead><tbody id="rows"></tbody></table>
    </div>
  </main>
  <script type="module">
${createIngestTracker}
${createVersionTracker}
${versionColor}
${splitChartSegments}
${runDashboard}
runDashboard();
  </script>
</body></html>`;
}

module.exports = {
  createIngestTracker, createVersionTracker, renderLivePage, splitChartSegments,
  versionColor,
};
