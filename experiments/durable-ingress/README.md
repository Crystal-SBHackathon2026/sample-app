# 영속 접수 계층 격리 실험

기존 앱이 쓰기 정지 시 503을 반환해 봇 요청이 5분 뒤 만료되는 문제를 재현하고,
고정 접수 API → Redis Streams → 기존 sample-app API → PostgreSQL 경로를 검증한다.
프로덕션 배포물 또는 AWS CDC 무중단 완료 증거가 아니다. 기존 API/봇은 수정하지 않았다.

## 실행

Node 22+, Docker 필요. 저장소 루트에서:

```sh
npm ci
npm ci --prefix experiments/durable-ingress
node experiments/durable-ingress/enqueue-fault-test.js
node experiments/durable-ingress/test.js
# 짧은 회귀 확인 (5분 만료 검증을 대체하지 않음)
HOLD_SECONDS=2 node experiments/durable-ingress/test.js
```

전용 Redis/Postgres 컨테이너와 임의 localhost 포트를 생성한다. PG 비밀번호는 실행 중
환경변수로만 전달한다. 종료 시 컨테이너 제거. Redis AOF는 임시 디렉터리에 합성 요청만 저장.
Redis는 appendonly=yes, appendfsync=always, noeviction. 최종 JSON은 results.json.

## 2026-11-06 측정 결과

`RESULTS_FILE=results-long.json node experiments/durable-ingress/test.js` 완료:

| 시험 | 결과 |
| --- | --- |
| 310초 쓰기 정지, 10rps | 접수 3,100건, 최초 HTTP 실패 0, 유실·중복·필드 불일치 0 |
| 정지 해제 후 3,100건 처리 | 55.167초, 정지 포함 365.699초 |
| 접수 응답 시간 | p95 11.41ms, 최대 132.87ms |
| 소비자 재시작 / DB commit 직후 강제 종료 | pause 유지 / 재처리 후 중복·유실 0 |
| Redis 강제 종료·재시작 | 기존 접수 유실 0, 중단 중 새 요청은 503 |
| 짧은 로컬 시연 | 250건, 쓰기 정지 21.379초 포함 전체 26.519초 |
| 전체 시나리오 최종 대조 | 접수 ID 3,352 = DB ID 3,352, 모든 필드 일치, pending 0 |

상세 원본: [results-long.json](results-long.json). 짧은 회귀 원본은 [results.json](results.json).
310초 시험은 기존 5분 만료를 넘기는 장애 시험이므로 그 자체로 5분 시연 예산을 초과한다.
26.519초는 큐 경로만의 리허설이며 실제 CDC·fencing·배포 시간을 포함하지 않는다.

## 확인 범위

- 기존 앱 pause의 실제 HTTP503, 새 API의 영속 접수 후 HTTP202
- 310초 소비 정지 중 10rps 입력, 다른 로컬 DB에 연결한 실제 앱 API로 재개
- DB request_id 집합/필드 비교, 중복 없음, 큐 pending 소진
- 소비자 재시작 시 pause 유지, DB commit 후 ACK 전 강제 종료 및 재처리
- Redis 강제 종료 전 접수한 요청의 복구
- Redis 중단 중 새 요청은 503: 이 단일 큐 구성은 큐 장애 시 접수 무중단을 보장하지 않음
- 큐 잘못된 타입 오류 시 고아 accepted 기록 방지, 중복 접수/내용 충돌
- 20초 정지 + 재개/소진 로컬 시연 시간 (실제 CDC 복사/최종 비교 시간 제외)

202는 접수이며 committed와 다르다. 요청을 재시도로 숨겨 성공으로 바꾸지 않는다.
기존 봇/API 클라이언트는 async 계약을 지원하도록 별도 변경이 필요하다.

## 발견하고 고친 결함

첫 enqueue Lua의 HSET 성공 뒤 XADD 실패 시 Redis는 이전 명령을 롤백하지 않았다.
장애 주입 결과 첫 POST503 → orphan=accepted → 재POST202를 재현했다.
XADD를 pcall로 검사하고 실패 시 새 hash를 삭제하여 보상한다.
회귀 결과 첫503 → orphan=null → 재POST503, 큐 복구 후 같은 ID 접수/중복검사 통과.

## 실제 전환 연결 전 남은 조건

이 실험은 단일 consumer이며 최초 대상 변경 시 consumer를 완전히 종료한 상태에서 바꾼다.
제어 API·in-flight drain·target epoch·리더 선출은 구현하지 않았다.
따라서 운영 중 Redis target/paused 값을 임의 변경해서는 안 된다.
실제 cutover와 연결할 때 기존 DB 워커와 큐 consumer 모두 pause/drain을 확인한 뒤 fencing,
최종 동기화, 대상 앱/DB 전환, 재개를 해야 한다. 동일 ID를 여러 writer DB에 쓰면 안 된다.
영구 충돌/내용 불일치는 오류를 기록하고 소비를 정지한다. 자동 해소나 DLQ는 미구현.

AWS CDC, 원본 권한 fencing, 실제 봇/브라우저, 읽기 전환, 네트워크 단절, 큐 포화,
다중consumer, 노드·디스크 손실, 20분 정지는 별도 검증이 필요하다.
5분 시연은 초기 복제/대상 준비를 미리 완료하고 전환 구간을 시연하는 안이며,
실제 17만 행 왕복 전체가 5분 내 완료된다는 주장이 아니다.

## 기존 전체 테스트와의 구분

기존 `npm test`도 실행했으나 CLI HTTP 인증 테스트(B2/B4/B5 등)가 각 20초 타임아웃으로
실패하며 정체되어 중단했다. 이 실험은 기존 앱 코드를 변경하지 않지만, 전체 기존 회귀가
통과했다고 주장하지 않는다. 원인은 미확정이다. 본 결과는 experiments의 실제 HTTP/DB
격리 시나리오와 enqueue 장애 회귀에 한정한다.
