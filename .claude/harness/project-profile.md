# 프로젝트 프로필 — Team Ghost sample-app

## 1. 정체성 (identity)

- SoftBank Hackathon 2026 Team Ghost의 서비스 이전 검증 앱과 재사용 모듈.
- 사용자: 김태윤 및 팀 개발자. 보고 언어: 한국어.
- 현재 요청: PostgreSQL 저장·조회 API, 영속 HTTP 트래픽 봇, 본선용 배포 설정.

## 2. 기술 스택 (stack)

- CommonJS JavaScript, Node.js 22, Express 4, npm, PostgreSQL/pg.
- src/: 샘플 앱. packages/request-store/: DB 코어와 HTTP 어댑터.
- packages/traffic-bot/: 앱 독립 HTTP 봇과 CLI. test/: node:test.
- k8s/: 본선용 Kustomize AWS/onprem 오버레이. .github/: CI.

## 3. 검증 명령 (verify)

- 타입/문법 검사: harness.env의 HARNESS_TYPECHECK_CMD 참조.
- 단위 테스트: npm test. 실제 PostgreSQL: npm run test:integration.
- 빌드: docker build -t ghost-sample-app:local .
- 스타일: harness.env 참조. HTTP·실제 DB 동작 검증 필수.
- 외부 EKS/k3s 배포 여부는 로컬 테스트와 구별한다.

## 4. 아키텍처 불변식 (invariants)

- request_id와 모든 불변 필드는 재시도에서 고정한다.
- 같은 ID·같은 내용은 기존 커밋으로 응답, 다른 내용은 충돌이다.
- DB 커밋 확인 전 성공을 반환하지 않는다.
- public.migration_demo의 스키마는 Notion 명세와 일치한다.
- 봇은 보내기 전에 요청을 영속 기록하고 재시작 후 미확인 요청을 재처리한다.
- 쓰기 정지에서도 조회와 liveness는 동작한다.
- API 정지만으로 모든 DB writer가 차단됐다고 주장하지 않는다.
- DB 코어는 Express와 샘플 앱에 의존하지 않는다.
- 봇은 DB에 직접 접속하지 않고 HTTP 어댑터 계약에 의존한다.
- 시크릿·DB 접속 문자열을 응답·로그·저장소에 노출하지 않는다.
- TLS를 사용하면 인증서를 검증하며 RDS CA는 외부 주입한다.

## 5. 경계면 맵 (boundaries)

- DB ↔ request-store: schema.sql의 여섯 필드.
- HTTP ↔ store ↔ bot: docs/api.md의 요청·응답·오류 계약.
- 재사용 모듈 ↔ sample-app: 공개 exports와 dependency injection.
- 앱 ↔ 전환 제어: 쓰기 정지/재개·drain·풀 교체, 다중 replica 제어는 외부 책임.
- 봇 ↔ 영속 ledger: 전송 전 기록, 재시작 복구, 단일 writer 락.
- 이미지 ↔ Kubernetes: DATABASE_URL Secret, /healthz와 /readyz 분리.

## 6. 배포·운영 모델 (ops)

- 서버: npm start, 8080. 봇: npm run bot, metrics 별도 포트.
- Dockerfile은 packages/와 SQL을 포함해야 한다.
- 대상 조직: SoftBankHackathon2026. 이미지: docker.io/kty1021/sample-app(공개).
- gitops 관련 sample-app 매니페스트도 본선용으로 조정한다.
- gitops 작업 브랜치: codex/sample-app-finals-db. 실제 클러스터 적용은 별도.
- 외부 서비스 배포·DB 변경은 이 작업의 완료 주장에 포함하지 않는다.

## 7. 버전관리 정책 (vcs)

- 기본 브랜치 main. 작업 브랜치 codex/modular-db-traffic.
- Conventional Commits, 기능 브랜치와 PR, squash merge는 사용자 승인 후.
- 검수(사용자 2026-11-04): 커밋마다 CC/CX 듀얼 1회, PR 전체 CC/CX 듀얼 3회.
- Phase 3의 추가 전체 3회 루프는 쓰지 않는다. 구정책 계수는 PR 3회에 넣지 않는다.
- 글로벌 설정은 건드리지 않고 템플릿의 프로젝트 글루만 설치한다.

## 8. 도메인 예시 (examples)

- 어느 앱에도 붙이기: Node 코어·Express router·독립 sidecar 실행 및 봇 adapter 제공.
- 무중단: DB 보존과 HTTP 지연을 별도 측정하며 팀 합의 전 SLO를 확정하지 않는다.

## 9. 지식 진입점 (knowledge entry)

- docs/spec-sources.md → 이번 작업의 Notion 명세와 관련 계약.
- 사용자 전역 저장 정책: Obsidian 저장은 명시적 요청 때만. 이번 요청은 저장 요청 아님.
- 구현 근거·API 계약은 이 저장소 docs/에 기록한다.
- claude-mem은 이 Codex 세션에서 미사용. git 이력과 _workspace/로 대체한다.

## 10. 하네스 출처와 실행 환경

- 정본: https://github.com/xodbs1021/kty-claude-harness-template
- 출처 SHA: ab266415be98badcee06d06253c43921e1449614
- 로컬 글루는 원본 그대로 복사; 도메인 슬롯만 이 프로젝트에 작성.
- Claude Code 훅은 다음 Claude 세션에서 실행; 현재 Codex는 검증을 직접 실행.
- ECC 전용 도구가 없으면 역할을 직접 수행하고 독립 검수자를 사용한다.
