const { test } = require("node:test");
const assert = require("node:assert");

test("HEALTH_FAIL=true면 헬스체크가 503을 돌려준다", async () => {
  process.env.HEALTH_FAIL = "true";
  delete require.cache[require.resolve("../src/app")];
  const { createApp } = require("../src/app");

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    assert.strictEqual(res.status, 503);
  } finally {
    server.close();
    delete process.env.HEALTH_FAIL;
  }
});
