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
