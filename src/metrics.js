const client = require("@prometheus-io/client");

// 🔴 지표 라벨에 커밋 SHA(APP_VERSION)를 넣지 않는다.
// 배포마다 시계열이 새로 생겨 Prometheus 메모리를 먹는다. 노드 3대 규모에서는 특히 위험하다.
// "지금 뜬 게 어느 커밋인지"는 kube_pod_container_info 의 이미지 태그로 본다.

// 요청 경로는 express 가 매칭한 라우트 이름으로만 쓴다.
// 들어온 URL 을 그대로 쓰면 없는 경로를 긁는 요청 하나하나가 새 시계열이 된다.
const UNMATCHED = "unmatched";

function createMetrics({ app, environment }) {
  const register = new client.Registry();
  register.setDefaultLabels({ app, env: environment });

  // 프로세스·Node 기본 지표 (힙, 이벤트 루프 지연, CPU, 파일 핸들)
  client.collectDefaultMetrics({ register });

  const requests = new client.Counter({
    name: "http_requests_total",
    help: "처리한 HTTP 요청 수",
    labelNames: ["method", "route", "status"],
    registers: [register],
  });

  const duration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP 요청 처리 시간(초)",
    labelNames: ["method", "route", "status"],
    // 이 앱은 계산이 없어 대부분 10ms 안에 끝난다. 느려지는 쪽을 보려고 위를 길게 뒀다.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  });

  function middleware(req, res, next) {
    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
      const route = req.route ? req.route.path : UNMATCHED;

      // /metrics 자체는 세지 않는다. 30초마다 긁히니 에러율·지연 계산을 전부 덮어쓴다.
      if (route === "/metrics") return;

      const labels = { method: req.method, route, status: String(res.statusCode) };
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      requests.inc(labels);
      duration.observe(labels, seconds);
    });

    next();
  }

  return { register, middleware };
}

module.exports = { createMetrics, UNMATCHED };
