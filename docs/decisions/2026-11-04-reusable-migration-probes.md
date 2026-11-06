# ADR-0001: 요청 저장과 이전 트래픽을 재사용 패키지로 분리

## Context

김태윤의 담당은 데모앱 저장·조회 API와 트래픽 봇이다.
사용자는 어느 앱에도 붙일 수 있는 모듈을 요청했다.
Notion은 public.migration_demo의 여섯 필드와 동일 ID 재시도를 정했다.

## Decision

npm workspaces의 request-store와 traffic-bot을 별도 패키지로 둔다.
DB 코어는 Express를 import하지 않고 HTTP router는 별도 export로 제공한다.
봇은 DB 코어를 import하지 않고 write/read adapter에 의존한다.
외부 Node 앱은 tarball을 설치하고, 다른 언어의 앱은 HTTP 계약을 구현한다.

## Alternatives Considered

- 앱 파일에 모두 구현: 빠르지만 재사용 요구와 모듈 경계를 충족하지 못한다.
- 다언어 SDK: 요구보다 범위가 크고 유지보수 대상을 불필요하게 늘린다.
- SQLite ledger: 가능하지만 Node22의 실험적 API나 네이티브 의존성을
  피하려고 bounded JSON snapshot과 표준 filesystem lease를 사용한다.

## Consequences

요청은 전송 전에 fsync·rename으로 보존하고 SIGKILL 뒤 재처리할 수 있다.
본문 전체를 저장하므로 합성 데이터 전용이며 디스크 손실까지 보장하지 않는다.
JSON snapshot은 누적 크기에 비례해 다시 쓰므로100000건/64MiB 상한을 둔다.
원자 교체 중에는 기존·새 snapshot을 위해최대2배 공간이 필요하다.
상한에 도달하면 자동 삭제하지 않고 실행을 실패로 알린다.

앱 pause는 프로세스 범위이며 전역 DB fencing과 CDC는 별도다.
커밋 여부가 끝내 미확정이면 unknown으로 보존하고 데이터 미저장으로 단정하지 않는다.

## 관련

- [명세 근거](../spec-sources.md)
- [API 계약](../api.md)
- [하네스 정본](https://github.com/xodbs1021/kty-claude-harness-template)
- 같은 주제의 저장소 내 선행 결정 없음.
