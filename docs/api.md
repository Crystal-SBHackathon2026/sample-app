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
- 모든 오류: {error:{code:string,message:string}}. 내부 DB 오류는 노출하지 않는다.
- GET /api/info: 환경 정보 + database:{name,row_count:string}, writes_paused.
- GET /readyz: DB 접속 및 테이블 조회 가능할 때 200, 아니면 503.
- GET /healthz: DB와 독립된 liveness.

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
- checkReady(): Promise<void>, COUNT 없이 테이블 조회 권한/접속 확인
- inFlightWrites: number getter, pause 뒤 drain 관측

별도 /express export의 createRequestRouter({store,getContext})는
POST /와 GET /:id를 제공한다. getContext는 environment와 region 등을 공급한다.
별도 /postgres export 또는 기본 export에 DB 구현과 SQL 경로를 문서화한다.
스키마는 앱 시작에서 자동 생성하지 않고 관리자 작업으로 사전 적용한다.

## 트래픽 모듈

@team-ghost/traffic-bot은 store를 import하지 않는다.
기본 HTTP adapter는 위 응답 계약을 사용한다. 다른 앱은 write(record,options)와
read(id,options)를 구현한 adapter를 주입하거나 요청 경로를 변경한다.
응답 record를 원래 요청 전체와 비교해야 committed로 기록한다.

요청 생성→영속 ledger 기록→HTTP 쓰기→같은 ID 조회 확인 순서다.
응답 유실·일반503은 같은 ID로 조회/재시도한다. 409·검증 불일치는 영구 실패로 남긴다.
기본 초당 1건·동시 1개. 요청/재시도·대기열/전체 지연·크기를 제한한다.
재시작 후 pending 요청을 먼저 처리한다. ledger는 단일 writer 락을 사용한다.
1초 요약은 stdout JSON, /metrics는 Prometheus, 원본 payload는 합성 데이터만.
CLI 환경변수와 공개 함수는 모듈 README에 기록한다.

## 입력 한도

run_id는 200자, phase는 100자, payload는 UTF-8 65536바이트 이하이며
NUL 문자는 허용하지 않는다. JSON 본문은 escaping을 고려해512KiB 이하이다.
추가 필드는 거절한다. request_no는 PostgreSQL signed bigint 범위를 지원한다.

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
