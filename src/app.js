const express = require("express");

// 배포 환경 정보: 어느 서버(클라우드)가 응답했는지 화면에서 바로 보이게 한다.
const info = {
  app: "sample-app",
  version: process.env.APP_VERSION || "dev",
  environment: process.env.DEPLOY_ENV || "local",
  region: process.env.DEPLOY_REGION || "local",
};

// 데모용 장애 주입: 0~1 사이 비율로 /api 요청을 500으로 실패시킨다.
// 카나리 배포에서 에러율 기반 자동 롤백을 보여줄 때 사용한다.
const failRate = Number(process.env.FAIL_RATE || 0);

function createApp() {
  const app = express();

  app.get("/healthz", (req, res) => res.json({ status: "ok" }));

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
  <p>버전: <b>${info.version}</b></p>
</body></html>`);
  });

  return app;
}

module.exports = { createApp, info };
