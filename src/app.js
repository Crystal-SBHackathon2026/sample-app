const express = require("express");
const { createMetrics } = require("./metrics");

// 배포 환경 정보: 어느 서버(클라우드)가 응답했는지 화면에서 바로 보이게 한다.
const info = {
  app: "sample-app",
  version: process.env.APP_VERSION || "dev",
  environment: process.env.DEPLOY_ENV || "local",
  region: process.env.DEPLOY_REGION || "local",
  // 컨테이너가 뜬 시각. 재배포·롤백이 실제로 일어났는지 화면에서 바로 확인한다.
  startedAt: new Date().toISOString(),
};

// 데모용 장애 주입: 0~1 사이 비율로 /api 요청을 500으로 실패시킨다.
// 카나리 배포에서 에러율 기반 자동 롤백을 보여줄 때 사용한다.
const failRate = Number(process.env.FAIL_RATE || 0);

// 데모용 배포 실패 주입: true면 헬스체크가 실패해 새 버전이 준비되지 않는다.
// 헬스체크 실패 시 자동 롤백을 보여줄 때 사용한다.
const healthFail = process.env.HEALTH_FAIL === "true";

// 화면에는 커밋 앞 7자리만 보여준다. /api/info 는 전체 값을 돌려준다.
const shortVersion = info.version.length === 40 ? info.version.slice(0, 7) : info.version;

function createApp() {
  const app = express();

  // 지표 수집은 모든 라우트보다 먼저 붙인다. 404 도 세야 "없는 경로를 긁고 있다"가 보인다.
  const metrics = createMetrics({ app: info.app, environment: info.environment });
  app.use(metrics.middleware);

  // 앱 포트와 같은 포트로 낸다. deploy.yaml 의 runtime.port 는 하나뿐이고,
  // overlay 는 렌더러가 다시 만들기 때문에 포트를 더 뚫으려면 명세부터 바꿔야 한다.
  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", metrics.register.contentType);
    res.send(await metrics.register.metrics());
  });

  app.get("/healthz", (req, res) => {
    if (healthFail) return res.status(503).json({ status: "fail" });
    res.json({ status: "ok" });
  });

  app.get("/api/info", (req, res) => {
    if (failRate > 0 && Math.random() < failRate) {
      return res.status(500).json({ error: "injected failure" });
    }
    res.json(info);
  });

  app.get("/", (req, res) => {
    res.send(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>Crystal Sample App</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:60px auto">
  <h1>Crystal Sample App</h1>
  <p>응답한 환경: <b>${info.environment}</b> (${info.region})</p>
  <p>버전: <b>${shortVersion}</b></p>
  <p>기동 시각: <b>${info.startedAt}</b></p>
</body></html>`);
  });

  return app;
}

module.exports = { createApp, info };
