# @team-ghost/traffic-bot

PostgreSQL에 직접 연결하지 않는 재사용 HTTP 부하 모듈입니다.
Node.js 22 이상에서 실행하며 샘플 앱이나 Express에 의존하지 않습니다.
다른 앱은 호환 HTTP API를 제공하거나 `write/read` 어댑터를 주입합니다.

## 기본 실행

```bash
BOT_BASE_URL=http://localhost:8080 \
BOT_LEDGER_DIR=./data/ledger \
BOT_RUN_ID=forward_001 \
BOT_PHASE=onprem_live \
node packages/traffic-bot/bin/traffic-bot.js
```

기본 초당 최대 1건을 직렬 생성·전송하고 같은 ID를 조회하여 확인합니다.
지연·재시도 중에는 실제 생성률이 설정값보다 낮아질 수 있습니다.
`SIGINT`나 `SIGTERM`은 진행 중 HTTP를 중단하고 ledger를 보존합니다.
강제 종료 뒤에는 10초 lease 만료 후 같은 디렉터리로 복구합니다.

| 환경변수 | 기본값 | 의미 |
| --- | --- | --- |
| `BOT_BASE_URL` | 필수 | 단일 공개 진입점, HTTP(S), URL 안 인증정보 금지 |
| `BOT_REQUESTS_PATH` | `/api/requests` | 저장 API 경로 |
| `BOT_LEDGER_DIR` | `./data/ledger` | 영속 디렉터리. Kubernetes에서는 PVC |
| `BOT_RATE` | `1` | 초당 최대 생성 수, 0 초과 1000 이하 |
| `BOT_RUN_ID` | 임의 UUID | 실행 구분자, 재시작 시 같은 값 권장 |
| `BOT_PHASE` | `onprem_live` | 생성 당시 구간 |
| `BOT_METRICS_PORT` | `9091` | `/metrics`, `/healthz` 포트 |
| `BOT_METRICS_HOST` | `0.0.0.0` | metrics 바인딩 주소 |
| `BOT_MAX_PENDING` | `1000` | 미확인 요청 최대 수 |
| `BOT_MAX_RECORDS` | `100000` | 완료 포함 ledger 최대 기록 수 |
| `BOT_MAX_LEDGER_BYTES` | `67108864` | ledger 최대 크기 |
| `BOT_MAX_REQUEST_AGE_MS` | `300000` | 최초 생성 후 최대 처리 시간 |
| `BOT_MAX_ATTEMPTS` | `20` | 요청별 POST 시도 상한 |
| `BOT_REQUEST_TIMEOUT_MS` | `5000` | 각 write/read 호출 제한 |
| `BOT_RETRY_DELAY_MS` | `1000` | 재시도 최소 대기 |

요약은 1초마다 JSON으로 stdout에 출력합니다. `pending`, `committed`,
`failed`, `unknown`, 시도/오류 수, 최근 1000개 커밋 지연 p95/p99/최대,
환경별 커밋 확인 비율을 포함합니다. 환경 비율은 이 프로세스에서 확인한 값입니다.
커밋 지연은 전송 시간뿐 아니라 최초 생성부터 대기·재시도까지 포함합니다.

## 모듈 사용

```js
const {createTrafficBot, createHttpAdapter} =
    require('@team-ghost/traffic-bot');

const bot = await createTrafficBot({
  adapter: createHttpAdapter({baseUrl: 'https://app.example.com'}),
  ledgerDir: '/data/ledger',
  ratePerSecond: 1,
  runId: 'forward_001',
  phase: 'onprem_live',
  onSummary: (summary) => console.log(JSON.stringify(summary)),
});

void bot.start();
// await bot.pause(): HTTP 전송을 정지하고 진행 중 배치를 기다린다.
// 정지 중 새 요청은 ledger 대기열에 쌓인다.
// bot.resume(): 대기한 요청부터 처리한다.
// await bot.stop(): 진행 중 호출 중단, ledger flush, lease 해제.
```

직접 만든 요청은 `await bot.enqueue(record)`로 영속 등록하고
`await bot.processPending()`으로 한 번 처리할 수 있습니다.
`processPending()`은 생성 루프 없이 테스트·외부 스케줄러와도 사용할 수 있습니다.
같은 프로세스에서 동시 호출하면 진행 중 배치를 공유합니다.

```js
const adapter = {
  async write(record, {signal}) {
    const order = await otherApp.createOrder(record, {signal});
    return normalizeOrder(order);
  },
  async read(requestId, {signal}) {
    const order = await otherApp.findOrder(requestId, {signal});
    return order ? normalizeOrder(order) : null;
  },
};
```

`normalizeOrder`는 아래 모양을 반환해야 합니다. 원본 여섯 필드는
한 글자라도 다르면 확인 실패입니다. 다른 필드 이름의 API는 이 어댑터에서
변환합니다. 쓰기는 실제 커밋 후에만 이 응답을 반환해야 합니다.

```json
{
  "status": "committed",
  "request": {
    "request_id": "21d10fd2-5b3c-4ab3-9c7f-c47ee6234e59",
    "run_id": "forward_001",
    "phase": "onprem_live",
    "request_no": "1",
    "payload": "synthetic demo payload",
    "created_at": "2026-11-04T00:00:00.000Z"
  },
  "environment": "onprem",
  "database": {"name": "migration_demo"}
}
```

UUID는 소문자, `request_no`는 0 이상 PostgreSQL bigint 범위 십진 문자열,
`created_at`은 UTC 밀리초 ISO 문자열입니다. `run_id`는 200자,
`phase`는 100자, `payload`는 UTF-8 64KiB 이하이며 NUL은 금지합니다.
기본 HTTP 어댑터는 200/201 응답을 읽고 조회 404를 `null`로 반환합니다.
409 등 영구 4xx는 재시도하지 않습니다. 408/425/429 및 5xx는 제한 내에서
재조회·재시도하며 `Retry-After`를 존중합니다. 리다이렉트는 거부합니다.
HTTP 응답은 기본 512KiB로 제한합니다.

503의 작은 JSON 오류 본문에 정확히 `error.code=WRITES_PAUSED`가 있으면
저장하지 않았다는 명시적 응답으로 처리합니다. 이 경우 POST 시도 상한을
소모하지 않고 `Retry-After` 후 같은 ID로 다시 보냅니다. 전체 최대 처리 시간과
대기열 상한은 계속 적용합니다. 일반 503·네트워크 오류는 커밋 여부가
불명확하므로 기존 시도 상한과 조회 복구를 그대로 적용합니다.

커스텀 어댑터의 오류는 `{terminal: true}`면 영구 실패,
`{retryAfterMs: number}`면 다음 재시도 대기를 지정합니다.
내부 오류 메시지는 시크릿을 포함할 수 있어 ledger에 기록하지 않습니다.
어댑터가 signal을 무시해도 봇은 제한 시간 후 결과를 기다리지 않습니다.
외부 HTTP 라이브러리도 취소할 수 있도록 signal을 전달해야 합니다.

## 내구성과 한계

전송 전 `ledger.json`에 요청을 기록하고 파일 fsync, atomic rename,
디렉터리 fsync를 수행합니다. 상태 변경도 같은 순서로 보존합니다.
단일 writer lease는 `proper-lockfile`의 mkdir·heartbeat로 관리합니다.
동일 디렉터리를 여러 봇에 공유하지 마세요. 파일시스템은 rename과 fsync,
mtime을 올바르게 제공해야 합니다. 원자 교체 중에는 최대 두 배의
ledger 크기만큼 디스크 공간이 필요합니다. 이전 강제 종료의 임시 파일은
배타 lease를 얻은 다음 정리합니다. 로컬 디스크 손실까지 복구하지는 않습니다.

재시작은 pending을 먼저 재처리하며 기존 POST 시도가 있으면 먼저 조회합니다.
POST 응답 유실도 같은 ID로 조회하고 원본 요청 전체를 대조합니다.
시도/시간 상한을 넘긴 미확인 POST는 마지막 조회로 커밋을 판정합니다.
여전히 알 수 없으면 `unknown`으로 남겨 수동 확인하고 새 POST를 보내지 않습니다.
`unknown`은 실패나 데이터 손실이 확정됐다는 뜻이 아닙니다.
한 번도 보내지 않은 만료 요청은 `failed`, 필드 불일치·영구 4xx도 `failed`입니다.

요청 로그는 완료 후에도 남겨 이전 후 대조에 사용합니다. 설정된 전체 기록·크기
상한에 도달하면 새 생성을 중단하고 fatal 요약 및 CLI 종료 코드 1로 보고합니다. pending 상한에서는 생성을 잠시 멈추고 `generation_blocked`를 늘리며
기존 요청의 조회·재시도를 계속합니다. 대기열에 여유가 생기면 생성도 재개합니다. 자동 삭제나 조용한 누락은 없습니다. 다음 실험은 기존 ledger를
보관하고 새 디렉터리·run ID로 시작하세요. 합성 payload만 사용하세요.

봇이 제공하는 증거는 HTTP 생성·조회 결과입니다. DB 전체 행 비교,
CDC 완료, 기존 writer 차단, 양쪽 DB의 원자적 전환은 별도 검증이 필요합니다.

## 커스텀 어댑터의 명시적 정지 거절

커스텀 어댑터도 저장 전에 거절했다는 보장이 있을 때만 다음 오류를 사용할 수 있습니다.
DB 장애나 커밋 여부를 알 수 없는 응답에는 사용하지 않습니다.

```js
const {HttpError} = require('@team-ghost/traffic-bot');
throw new HttpError(503, {notCommitted: true, retryAfterMs: 1000});
```

이 오류는 시도 예산을 소모하지 않지만 전체 시간·pending 상한은 유지합니다.
write_attempts/write_errors 지표에는 계획된 정지503도 실제 HTTP 결과로 포함됩니다.
정지 구간의 오류율을 장애율로 해석하지 말고 ledger의 WRITES_PAUSED와 비교하세요.
