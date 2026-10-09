const { test, after, before } = require("node:test");
const assert = require("node:assert");
const { createApp } = require("../src/app");

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("헬스체크는 200과 ok를 돌려준다", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { status: "ok" });
});

test("/api/info는 배포 환경 정보를 돌려준다", async () => {
  const res = await fetch(`${base}/api/info`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.app, "sample-app");
  assert.ok(body.environment);
});

test("정보 응답에 기동 시각이 들어 있다", async () => {
  const res = await fetch(`${base}/api/info`);
  const body = await res.json();
  assert.ok(body.startedAt, "startedAt 이 있어야 한다");
  assert.ok(!Number.isNaN(Date.parse(body.startedAt)), "startedAt 은 파싱 가능한 시각이어야 한다");
});

test("/metrics는 프로메테우스 형식으로 응답한다", async () => {
  const res = await fetch(`${base}/metrics`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);

  const body = await res.text();
  assert.match(body, /# HELP http_requests_total/);
  assert.match(body, /process_cpu_seconds_total/, "프로세스 기본 지표도 있어야 한다");
});

test("지표 라벨에 app과 env만 들어간다 — 커밋 SHA는 넣지 않는다", async () => {
  await fetch(`${base}/api/info`);
  const body = await (await fetch(`${base}/metrics`)).text();

  const line = body.split("\n").find((l) => l.startsWith("http_requests_total{"));
  assert.ok(line, "http_requests_total 표본이 있어야 한다");
  assert.match(line, /app="sample-app"/);
  assert.match(line, /env="/);
  assert.doesNotMatch(line, /version=/, "버전 라벨은 시계열을 배포마다 새로 만든다");
});

test("요청 경로는 매칭된 라우트 이름으로 센다 — 없는 경로는 unmatched 하나로 모인다", async () => {
  await fetch(`${base}/없는경로/${Date.now()}`);
  await fetch(`${base}/없는경로/${Date.now()}-2`);
  const body = await (await fetch(`${base}/metrics`)).text();

  const unmatched = body
    .split("\n")
    .filter((l) => l.startsWith("http_requests_total{") && l.includes('route="unmatched"'));
  assert.strictEqual(unmatched.length, 1, "없는 경로가 여러 시계열로 갈라지면 안 된다");
  assert.doesNotMatch(body, /없는경로/, "들어온 URL 이 라벨로 새면 안 된다");
});

test("/metrics 자체는 세지 않는다 — 긁는 요청이 에러율을 덮어쓴다", async () => {
  await fetch(`${base}/metrics`);
  const body = await (await fetch(`${base}/metrics`)).text();
  assert.doesNotMatch(body, /route="\/metrics"/);
});
