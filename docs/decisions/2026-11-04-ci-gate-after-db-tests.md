---
status: accepted
related: "https://github.com/Crystal-SBHackathon2026/sample-app/issues/29"
---

# ADR-0003: DB 시험을 통과한 커밋만 이미지로 게시하고 main에서도 스캔

## Context

예선 저장소 issue #29(「배포 전 구간 시간 단축 — CI 가 같은 빌드를 두 번
한다」, 2026-10-10 종료)는 배포 데모 시간을 줄이려고 CI를 바꿨다. 원문의
결정은 다음과 같다.

- ② `build`의 `needs: test` 제거로 병렬화, 기대 절약 20초.
- ③ GitOps 태그 갱신을 `build` job 안으로 옮기고 `clone --depth 1`.
- 「Trivy 를 PR 에서 빼는 것도 선택지였지만 하지 않는다」.
- 「카나리 60초는 줄이지 않는다」.

예선 기준선 `ci.yml` 주석은 #29에 따라 두 가지를 더 기록했다.

- main에서는 Trivy를 건너뛴다. 단계별 실측에서 Trivy가 9초, docker build가
  5초였다. `needs: test`는 PR·main 양쪽에서 10초를 직렬로 더 썼다.
- latest 태그를 쓰지 않는다. 배포는 GitOps `newTag`(병합 커밋 SHA)로만 한다.

이 맞바꿈의 전제는 브랜치 보호였다. PR에서 `test`·`build`·
`review-service/verify`를 필수로 요구하고 squash 병합이라, main 트리는 이미
시험과 스캔을 통과한 트리와 같고 설치 패키지도 같다는 것이다.

이번 작업은 실제 PostgreSQL 통합 시험이 필요한 DB 모듈을 이미지에 넣는다.
본선 조직 `SoftBankHackathon2026`의 브랜치 보호 설정은 확인하지 못했다.

## Decision

현행 게이트를 유지한다. #29의 ②와 main 스캔 생략은 되돌린 상태로 둔다.

1. `test`: PostgreSQL 17 서비스, `npm run check`, `npm test`,
   `npm run test:integration`, Kubernetes 렌더.
1. `build`(`needs: test`): 이미지 빌드, PR과 main 모두 Trivy
   (`vuln,secret`, CRITICAL, `--ignore-unfixed`).
1. main에서만 GHCR 게시, 같은 job 안에서 GitOps `newTag` 갱신.

#29의 ③(태그 갱신을 같은 job에서), latest 태그 미사용, 카나리 60초 유지는
그대로 따른다.

바꾸는 이유는 셋이다.

- 새 조직의 브랜치 보호를 확인하지 못해 "main 트리는 이미 시험을
  통과했다"는 전제가 서지 않는다. `needs: test`가 없으면 main에서 시험이
  깨져도 게시와 태그 갱신이 진행된다.
- PR 빌드와 main 빌드는 별개다. 그 사이 베이스 이미지나 패키지 인덱스가
  바뀔 수 있어 PR 스캔 결과가 게시 이미지를 대표한다고 보장할 수 없다.
- PR 스캔 뒤에 새 CRITICAL CVE가 공개될 수 있다. 게시 대상 이미지를
  직접 스캔해야 한다.

## Alternatives Considered

- #29 방식 복원(병렬, main 스캔 생략): 데모 시간은 짧지만 위 세 전제를
  확인할 수 없다.
- 브랜치 보호를 확인한 뒤 복원: 확인 권한과 결과가 아직 없다. 확인되면
  이 ADR을 다시 연다.

## Consequences

비용은 기록값과 실측값을 구분한다.

| 출처 | 값 | 성격 |
| --- | --- | --- |
| 예선 기준선 주석 | Trivy 9초, build 5초, 직렬 대기 10초 | 예선 기록, 재측정 아님 |
| head `41fcdb8` PR run 41763180023 | test job 49초, build job 20초 | 2026-11-04 조회, 재사용 |

run 41763180023은 이 ADR의 보완(재검수 r1)과 요청 API 인증 변경보다 앞선 head
`41fcdb8`의 결과를 재사용한 값이다. 이 게이트 정의 자체는 그 head와 같지만,
시험 수가 늘어난 새 head의 시간은 아니다. 새 head의 PR run에서 다시 재며,
아직 재지 않았다.

run 41763180023(head `41fcdb8`)의 단계 시간은 컨테이너 기동 10초, `npm test`
13초, `npm run test:integration` 12초, 렌더 5초, 이미지 빌드 7초, Trivy
9초였다.

`npm test`(DB 없음, PG 시험 생략)와 `npm run test:integration`(DB 필수,
스키마 초기화 뒤 전체 시험)은 DB와 무관한 시험을 두 번 돌린다. 로컬 README의
두 명령과 같은 단순한 계약을 지키는 비용으로 공개하고 받아들인다. 중복을
줄이는 최적화는 후속으로 미루며, 담당자는 김태윤이다.
main 전용 게시·태그 갱신 단계는 run 41763180023에서 건너뛰었으므로 아직
측정값이 없다. 병합 뒤 main run에서 담당자 김태윤이 잰다. 팀 합의 전에는 SLO나 시간
목표를 정하지 않는다.

선택 비용: PR과 병합 사이에 CRITICAL CVE가 새로 공개되면 main 게시가
실패하고 GitOps 태그 갱신도 멈춰 본선 배포가 막힌다. 대응은 취약한 의존성이나
베이스 이미지를 고친 뒤 다시 검사하는 것이다. 스캔을 끄거나 검사하지 않은
이미지를 손으로 게시하는 우회 배포는 하지 않는다.

## 관련

- [issue #29 원문](https://github.com/Crystal-SBHackathon2026/sample-app/issues/29)
- [CI 정의](../../.github/workflows/ci.yml)
- [배포 안내](../deployment.md)
