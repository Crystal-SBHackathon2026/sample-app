# DB request API 계약

Notion 여섯 필드를 변경하지 않는다. JSON의 request_no는 bigint 정밀도를
보존하기 위해 십진 문자열이다. UUID는 소문자로 정규화한다.
created_at은 timezone이 있는 ISO 8601이며 밀리초 정밀도로 정규화한다.

```json
{
  "request_id": "21d10fd2-5b3c-4ab3-9c7f-c47ee6234e59",
  "run_id": "forward_001",
  "phase": "onprem_live",
  "request_no": "1",
  "payload": "synthetic demo payload",
  "created_at": "2026-11-04T00:00:00.000Z"
}
```

## HTTP

- POST /api/requests: 새 커밋 201, 동일 요청 기존 커밋 200.
- GET /api/requests/:id: 존재 200, 없음 404.
- 응답: {status:"committed", created:boolean, request:{six fields},
  database:{name:string}, environment:string, region:string}.
- 조회 응답의 created는 생략 가능. database.name은 current_database() 결과.
- 같은 ID·다른 불변 필드: 409, error.code=REQUEST_CONFLICT.
- 잘못된 입력: 400. 정지/DB 장애: 503. 정지에는 Retry-After: 1.
- 호스트의 getContext가 비어 있지 않은 environment 문자열을 주지 않으면
  500, error.code=CONTEXT_INVALID. POST는 store.put 전에, GET은 조회 전에
  거절하므로 이 오류는 커밋을 동반하지 않는다.
- 모든 오류: {error:{code:string,message:string}}. 내부 DB 오류는 노출하지 않는다.
- GET /api/info: 환경 정보 + database:{name,row_count:string}, writes_paused,
  writes_in_flight, write_control:{healthy:boolean}.
- GET /readyz: DB 접속 및 테이블 조회 가능하고 종료 drain 중이 아닐 때 200,
  아니면 503. 제어 파일 상태는 readiness에 영향을 주지 않는다.
- GET /healthz: DB와 독립된 liveness.

제어 파일이 깨졌거나 writes_paused가 boolean이 아니면 쓰기는 정지된 채로
남는다(POST 503 WRITES_PAUSED). 조회·/api/info·/readyz는 계속 응답한다.
이 상태는 write_control.healthy=false, 지표 app_write_control_healthy=0,
상태가 바뀔 때 한 번의 warn 로그(invalid, recovered)로 드러난다.

## 요청 API 인증

샘플 앱은 `/api/requests` 아래 모든 경로와 method(POST, GET `/:id`, HEAD 등)
앞에 인증 guard를 둔다. guard는 제어 파일 확인, JSON 본문 해석, DB보다 먼저
응답한다. 경로 대소문자나 끝 `/`로 우회할 수 없다. `/`, `/healthz`,
`/readyz`, `/api/info`, `/metrics`에는 적용하지 않는다.

모드는 시작할 때 한 번 정한다. 아래 표의 "미정의"는 환경변수 키가 아예 없는
상태이고 빈 값(`""`)과 다르다. K8s Secret 참조가 `optional: true`인데
Secret이 없으면 그 변수는 미정의가 된다.

| `REQUEST_API_AUTH` | `REQUEST_API_TOKEN` | 모드 |
| --- | --- | --- |
| 미정의 또는 `optional` | 미정의 | open(인증 없음) |
| 미정의, `optional`, `required` | 유효한 토큰 | enforced |
| `required` | 미정의 | closed |
| 미정의, `optional`, `required` | 빈 값, 32자 미만, 허용 밖 문자 | closed |
| 그 밖의 값(빈 값, `REQUIRED`, `disabled` 등) | 무관 | closed |

유효한 토큰은 32자 이상이고 RFC 6750 2.1 b64token 문법(영문자, 숫자,
`-._~+/` 뒤에 `=` 0개 이상)을 따른다. 서버는 시작할 때 토큰의 SHA-256
digest만 보관하고 `timingSafeEqual`로 비교한다. 토큰과 Authorization 헤더
원문은 응답, 로그, 지표에 남기지 않는다.

| 상황 | 응답 |
| --- | --- |
| enforced, 헤더 없음 또는 다른 scheme | 401 `UNAUTHORIZED`, `WWW-Authenticate: Bearer realm="request-api"` |
| enforced, 틀리거나 형식이 깨진 Bearer 토큰 | 401 `UNAUTHORIZED`, `WWW-Authenticate: Bearer realm="request-api", error="invalid_token"` |
| closed | 503 `API_AUTH_UNCONFIGURED`, `WWW-Authenticate`와 `Retry-After` 없음 |
| open 또는 정상 토큰 | 위 HTTP 절의 기존 계약 |

요청 헤더는 `Authorization: Bearer <토큰>`이다. scheme은 대소문자를 가리지
않고, 뒤에 공백 하나 이상을 허용한다. 401 본문은
`{error:{code:"UNAUTHORIZED",message:"Missing or invalid API token"}}`, 503
본문의 message는 `Request API authentication is not configured`다. 정상
토큰이면 쓰기 정지 중에도 GET은 200, POST는 503 `WRITES_PAUSED`다.

RFC 6750 범위: Authorization 헤더 방식과 3절 challenge 형식만 따른다. 형식이
깨진 Bearer 요청에도 RFC 권고인 400 `invalid_request` 대신 같은 401
`invalid_token`을 준다. 고정 공유 토큰이라 수명과 scope가 없고, 서버는 전송
계층(TLS)을 검사하지 않는다. RFC 6750 전부를 준수한다고 주장하지 않는다.

관측:

*   `app_request_api_auth_mode{mode}`: `open`, `enforced`, `closed` 중 현재
    모드만 1이고 나머지는 0이다. 재시작할 때 다시 계산한다. 공개 `/metrics`에
    있으므로 모드가 외부에 보이는 잔여 위험이 있다.
*   `app_request_api_auth_rejected_total{reason}`: 401마다 `unauthorized`,
    closed 503마다 `unconfigured`가 1씩 는다. 라벨 값은 이 두 개로 고정이다.
*   open과 closed는 시작할 때 warn 로그를 한 번 남긴다. enforced는 남기지
    않는다. 요청마다 로그를 남기지 않는다.

봇 해석: 401은 POST가 DB에 닿지 않았으므로 즉시 failed(`HTTP_401`)다.
closed 503은 `WRITES_PAUSED`가 아니어서 일반 503처럼 같은 ID GET과 재시도로
확인한다. closed에서는 GET도 503이므로 예산을 다 쓰면 실제로는 커밋되지
않았어도 unknown으로 남는다.

두 변수가 모두 미정의인 open은 기존 SDK와 로컬 시험 호환을 위한 기본값이다.
공개 노출 대상은 `REQUEST_API_AUTH=required`로 배포한다.

## 재사용 DB 모듈

@team-ghost/request-store 코어는 Express에 의존하지 않는다.
createPostgresRequestStore({connectionString,ssl,connectionTimeoutMillis,
statementTimeoutMillis,max,...})를 제공한다.

- put(record): Promise<{created,request,database:{name}}>
- get(id): Promise<{request:record|null,database:{name}}>
- status(): Promise<{name,row_count}>
- pauseWrites(): Promise<void>, 새 쓰기 차단 후 진행 중 쓰기 drain
- resumeWrites(): void
- writesPaused: boolean getter
- replaceConnection(options): Promise<void>, paused일 때만 검증 후 교체
- close(): Promise<void>
- checkReady(): Promise<{name}>, COUNT 없이 테이블 조회 권한/접속 확인
- inFlightWrites: number getter, pause 뒤 drain 관측

replaceConnection은 후보 풀에서 테이블 조회를 확인한 뒤 참조를 먼저 바꾸고,
옛 풀 end()는 그다음 best-effort로 부른다. end() 실패는
onObservation의 connection/error로만 기록하며 교체는 성공하고 후보 풀은
닫지 않는다. 조회는 drain·후보 검증 동안만 503이고, 참조 교체 뒤에는 옛 풀
정리 중에도 후보 풀로 응답한다. 쓰기·resumeWrites·다른 교체는 정리가
끝날 때까지 DB_UNAVAILABLE이고, close()는 교체가 끝난 뒤 남은 풀을 닫는다.

별도 /express export의 createRequestRouter({store,getContext})는
POST /와 GET /:id를 제공한다. getContext는 필수 함수이며 없으면 생성 시점에
TypeError를 던진다. 반환값은 {environment: 비어 있지 않은 문자열}을 포함해야
하고 region 등 다른 메타데이터를 더할 수 있다. 봇이 environment를 필수로
검증하기 때문이다.

TLS 정책: postgresOptionsFromEnv는 PGSSLMODE의 require, verify-ca,
verify-full을 모두 인증서 체인 검증과 Node 기본 호스트명 검증으로 해석한다.
libpq의 require(검증 없음)와 verify-ca(호스트명 미검증)보다 강하며, 이 모듈은
그 약한 의미를 제공하지 않는다. 서버 인증서는 주입한 CA(PGSSLROOTCERT 또는
DB_SSL_CA, RDS CA는 외부 주입)로 검증돼야 하고 SAN이 접속 호스트와 맞아야
한다. 이 문서는 정책이며 실제 운영 DB의 TLS 접속 검증을 대신하지 않는다.
코어에 직접 넘기는 ssl은 true, false, 미지정, 인증서를 검증하는 객체만 받고
나머지는 INVALID_CONFIGURATION으로 거절한다(모듈 README).
DB 구현(createPostgresRequestStore, postgresOptionsFromEnv)은 기본 export에,
스키마 SQL은 /schema.sql export에 있다.
스키마는 앱 시작에서 자동 생성하지 않고 관리자 작업으로 사전 적용한다.

## 트래픽 모듈

@team-ghost/traffic-bot은 store를 import하지 않는다.
기본 HTTP adapter는 위 응답 계약을 사용한다. 다른 앱은 write(record,options)와
read(id,options)를 구현한 adapter를 주입하거나 요청 경로를 변경한다.
응답 record를 원래 요청 전체와 비교해야 committed로 기록한다.

요청 생성→영속 ledger 기록→HTTP 쓰기→같은 ID 조회 확인 순서다.
응답 유실·일반503은 같은 ID로 조회/재시도한다. POST 409와 명시적 4xx
거절(408·425·429 제외)은 즉시 영구 실패다. 2xx를 받은 뒤의 해석 오류·크기
초과·내용 불일치는 커밋 미확정이므로 같은 ID GET으로 판정한다. GET이 같은
요청이면 committed, 다른 내용이면 CONTENT_CONFLICT로 failed, 없음·오류면
pending이고 예산을 다 쓰면 unknown이다.
기본 초당 1건·동시 1개. 요청/재시도·대기열/전체 지연·크기를 제한한다.
재시작 후 pending 요청을 먼저 처리한다. ledger는 단일 writer 락을 사용한다.
1초 요약은 stdout JSON, /metrics는 Prometheus, 원본 payload는 합성 데이터만.
CLI 환경변수와 공개 함수는 모듈 README에 기록한다.

## 입력 한도

run_id는 200자, phase는 100자, payload는 UTF-8 65536바이트 이하이며
NUL 문자는 허용하지 않는다. JSON 본문은 escaping을 고려해512KiB 이하이다.
추가 필드는 거절한다. request_no는 PostgreSQL signed bigint 범위를 지원한다.
run_id·phase·payload에 짝 없는 UTF-16 surrogate(단독 surrogate)가 있으면
DB 쓰기 전에 400 INVALID_REQUEST로 거절한다. PostgreSQL UTF-8 저장에서
U+FFFD로 바뀌어 내용이 달라지기 때문이다. 정상 이모지 같은 보조 평면 문자는
그대로 저장한다.

## 미확인 결과

봇이 이전에 전송한 요청은 재시도/시간 한도 이후에도 마지막 GET으로 확인한다.
일치하는 커밋을 확인하지 못하면 unknown으로 보존하고 새 POST는 하지 않는다.
unknown은 DB 미저장 확정이 아니며 수동 정합성 확인 대상이다.

읽기 경로는 pause drain을 기다리지 않는다. writes_paused와 writes_in_flight를
함께 관측하고, 오케스트레이터가 모든 replica의 진행 중 쓰기0을 확인한다.

WRITES_PAUSED=true는 프로세스 수명 동안 강제 정지이며 제어 파일false보다 우선한다.

## 호환 서버의 정지 거절 보장

POST503의 error.code=WRITES_PAUSED는 DB 쓰기를 수락하기 전에 반환하며,
그 POST가 커밋되지 않았음을 보장한다. 커밋 후 오류·결과 미확정·일반 DB 장애에는
이 코드를 사용하지 않는다. 봇은 이 거절만 시도 예산에서 제외하고 Retry-After를
따른다. 전체 나이·pending·디스크 상한은 계속 적용한다.
일반503·응답 유실은 동일 ID 조회와 재시도 예산을 유지한다.

write_attempts/write_errors는 실제 HTTP 시도·비성공 응답 횟수이며,
계획된 쓰기 정지의503도 포함한다. 이 값만으로 장애 또는 데이터 손실을 판정하지 않는다.
ledger의 lastError=WRITES_PAUSED와 제어 상태를 함께 해석한다.
