# 구현 검증 기록

2026-11-04 로컬 검증. 실제 EKS/k3s 적용, RDS 접속, CDC 왕복 이전은 수행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| Node22 컨테이너 + PostgreSQL17 전체 통합 테스트 | 47개 통과, 실패0, 생략0 |
| npm run check | JavaScript 문법 검사 통과 |
| npm audit --omit=dev | 알려진 취약점0 |
| actionlint | GitHub Actions 정의 검사 통과 |
| Docker build | 앱·봇 공용 이미지 빌드 성공 |
| Docker HTTP smoke | health/ready200, 실제DB식별, 봇 쓰기·조회 성공 |
| npm pack 외부 설치 | 별도 임시 프로젝트의 /probe API + 봇 + 실제PG 성공 |
| Kubernetes render | 앱AWS/onprem·봇, GitOpsAWS/local/onprem/GCP·onprem분석 성공 |
| 독립 검수 | Claude 정적검수, Codex 직접테스트·계약 대조; 최종 C0/H0 |

회귀 범위는 동시 동일ID 단일행, 불변필드 충돌, 최소권한 앱 역할, 쓰기 정지 중 조회,
DB 장애와 readiness/liveness 분리, 풀 교체·종료 경쟁, TLS 설정,
응답 유실·SIGKILL·ledger 복구, 만료 미확인 보존, 대기열 제한,
명시적 정지503과 일반503의 시도 예산 구분을 포함한다.

재현 명령과 입력 계약은 루트 README와 모듈 README를 따른다.
테스트에는 반드시 버릴 수 있는 TEST_DATABASE_URL을 사용한다.
검수 원본·실행 로그·로컬 패키지 산출물은 git 제외 _workspace/에 있다.

## 확인 한계

봇은 유한 기록을 보관하며 전체 한도에서 종료한다. Kubernetes 기본값은
10000건/8MiB로1건/s에서 건수 기준약2.8시간이다. 기록은 자동 삭제하지 않는다.

DB fencing·CDC 최종 일치·모든 replica 정지 확인은 별도 오케스트레이터의 책임이다.
진단 DB 건수는 최대1초 캐시다. 실제 배포에는 새 이미지 게시·GitOps 태그 교체,
환경별 Secret·진입점이 필요하다. 렌더와 로컬 테스트를 배포 완료로 해석하지 않는다.

claude-mem은 이 Codex 작업에서 사용하지 않았으며 git/로컬 작업 기록으로 대체했다.
하네스는 프로젝트 범위에 설치했고 전역 설정은 변경하지 않았다.
