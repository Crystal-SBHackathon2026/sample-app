# 구현 검증 기록

2026-11-04 로컬 검증. 실제 EKS/k3s 적용, RDS 접속, CDC 왕복 이전은 수행하지 않았다.

## 1차 구현 검증 (재검수 이전)

아래 표는 재검수 보완 이전 코드의 결과다. 보완 뒤 전체 결과는 통합 실행으로
다시 판정한다.

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

## 재검수 보완: 배포 선언

배포 선언 범위에서 실제로 실행한 검증이다. 로그는
`_workspace/recheck-20261104/phase3/`의 `red-deploy-*`, `green-deploy-*`다.

| 검증 | 결과 |
| --- | --- |
| 고정 SHA 렌더러(review-service `3f874c8`), Linux Python 3.13 | 기존 `deploy.yaml`은 blocking `TLS_HOST_MISSING`, 새 입력은 blocking 0 |
| 렌더 출력 대조 | `ingress.yaml`·`kustomization.yaml` sha256이 사전 제안 렌더와 같음, gitops에 바이트 그대로 복사 |
| `kubectl kustomize runtime/aws` | 컨테이너 1, env 중복 0, DB·TLS·제어 값, mount 2, volume 2, readiness `/readyz`·3초, ALB `/readyz`, 제어 true |
| wrapper 음성 시험 | 이름 guard 변경, volumes guard 변경, storage가 든 실제 렌더 위 build 모두 실패 |
| 다른 환경 렌더 | local·onprem·gcp·analysis가 gitops PR head `9d786b3`과 같음. base 대비 diff 보존 |
| 봇 run_id 매니페스트 시험 | `forward_001`에서 실패, `ghost_bot_forward_001`에서 통과 |
| legacy 복구 Job | 합성 볼륨 5경우: 빈 디렉터리만 제거, symlink·비어 있지 않음·일반 파일 거절, 데이터 불변 |
| CI 정의 | 주석만 변경, 파싱한 워크플로 구조가 HEAD와 같음 |

kustomize JSON6902 `test`는 kubectl v1.37.0(Kustomize v5.8.1)에서 확인했다.
Argo CD에 내장된 kustomize 버전에서의 동작은 확인하지 않았다.

PR CI run 41763180023은 재검수 보완 이전 head `41fcdb8`의 결과다(test job
49초, build job 20초). 이 절과 아래 S1 절의 변경을 포함하지 않으므로 새 head의
CI 증거로 쓰지 않는다. main 전용 게시·태그 갱신은 그 run에서 건너뛰어 측정값이
없다. 새 head의 CI와 병합 뒤 main run은 후속으로 확인한다.

재검수 보완(r1)을 합친 고정 트리에서는 Linux Node 22 + PostgreSQL 17로
`npm test` 100/100, `npm run test:integration` 100/100, 생략 0이었다. 이것은
S1 요청 API 인증 이전 r1의 증거다.

## 요청 API 인증(S1): 배포 선언

배포 선언 범위에서 실제로 실행한 검증이다. 로그는
`_workspace/recheck-20261104/phase3/red-s1-deploy.log`와
`green-s1-deploy.log`다.

| 검증 | 결과 |
| --- | --- |
| `test/deploy-manifests.test.js` | 새 시험 4건이 변경 전 실패(env 없음, `.env.example` 없음), 변경 뒤 8/8 통과 |
| `kubectl kustomize` 인증 env | sample-app base·aws·onprem, gitops `runtime/aws`·`overlays/onprem`이 `required`+Secret optional, 봇은 같은 Secret 필수, env 중복 0 |
| 렌더러 출력 위 wrapper | gitops `overlays/aws`가 고정 SHA 렌더러(`3f874c8`) r1 실제 출력과 바이트가 같고, 그 위 `runtime/aws`의 H1 검사 12건 통과 |
| 그 밖 불변 | 인증 env를 뺀 렌더가 r1 렌더와 같음. local·gcp 렌더 바이트 불변, `deploy.yaml`과 `overlays/aws` 불변 |
| 음성 변형 | optional 제거, AUTH 값 변경, env 중복, 봇 optional 추가, Secret 이름 변경, TLS 검증 해제 주입을 모두 검출 |

새 시험 중 env 중복 0과 `k8s/`의 TLS 검증 해제 부재는 변경 전에도 통과한 보존
시험이다. 실패를 먼저 보인 시험으로 세지 않는다.

S1을 합친 전체 suite와 Docker·npm pack 시험 결과는 다음 절에 있다. 위의
100/100은 S1 이전 결과이므로 S1 통합 결과를 대신하지 않는다.

## 요청 API 인증(S1): 합친 작업 트리 통합 실행

앱·봇·배포 S1을 합친 작업 트리에서 실제로 실행한 검증이다. 대상은 아직
커밋하지 않은 작업 트리다. 현재 커밋 sample-app `41fcdb8`과 gitops
`9d786b3`은 S1 이전 커밋이다. 로그는 `_workspace/recheck-20261104/phase3/`의
`s1-*`다.

| 검증 | 결과 |
| --- | --- |
| 실행 환경 | 작업 전용 Linux aarch64 컨테이너의 Node v22.23.4와 PostgreSQL 17. 호스트 전역 Node 26은 쓰지 않음 |
| `npm run check`, 스타일 검사 | 둘 다 exit 0 |
| `npm test` | 156/156 통과, 실패 0, 생략 0 |
| `npm run test:integration` | 스키마 초기화 뒤 156/156 통과, 실패 0, 생략 0 |
| Docker build | 이미지 `sha256:46df9ad3fa07e8a55b396c7a50fbefe9e12361427a6e5ac4929fc4cf8786ac50`, `npm ci --omit=dev` 취약점 0 |
| npm pack 소비자 | 새로 만든 `@team-ghost/request-store` 0.1.0과 `@team-ghost/traffic-bot` 0.2.0 tarball을 별도 앱에 설치. sample-app `src/` 미참조, `/probe`로 실제 PG에 1행, 봇 committed 1 |
| 패킹 파일 대조 | 패킹한 16개 파일(모듈 README 포함)의 sha256이 현재 작업 트리와 같음 |
| Docker 인증 스모크 | 위 이미지의 `USER node`(UID 1000). 아래 목록 참조 |
| Docker 재시작 스모크(H7) | 위 이미지, UID 1000. 컨테이너 안 node 자식(pid 6) SIGKILL → Docker 재시작 1회 → 같은 볼륨의 재시작 전 pending 요청을 같은 ID로 커밋, GET이 원본과 같음 |

`npm test`와 `npm run test:integration`의 156은 같은 suite를 두 번 실행한
계수다. 312개의 별개 기능이 아니다. 로컬 실행은 두 명령 모두 시험 DB가 연결된
상태여서 PG 시험도 생략되지 않았다. CI의 `npm test`는 DB 없이 돌아 PG 시험을
생략한다.

실행 로그에는 Node 버전만 찍혀 있다. Linux aarch64는 같은 고정 이미지를 쓴 S1
앱 로그(`green-s1-app-linux-node22-pg17.log`)의 `uname` 기록이다. 이 로그에
PostgreSQL 서버 버전 줄은 없다.

Docker 인증 스모크(run `auth-smoke-019c0caa`)에서 본 것은 다음과 같다.

- 토큰 없이 `forward_001` 행 주입을 시도하면 401이고, DB 행 수가 그대로다.
- 앱과 네트워크를 공유한 봇 CLI가 loopback HTTP로 토큰을 보내 1건을
  커밋했다. 인증 GET이 여섯 필드 모두 일치했다.
- loopback이 아닌 `http://` 대상이면 봇이 exit 1
  `INSECURE_TOKEN_TRANSPORT`로 멈춘다. 요청 0건, ledger 미생성이다.
- `required`에서 토큰 Secret이 없으면 요청 API는 503이고 `/`, `/healthz`,
  `/readyz`, `/api/info`는 각각 200이다.
- 두 스모크 모두 자기가 만든 컨테이너·볼륨의 제거를 확인했다.

H7 새 실행(run `docker-restart-91077f48`)은 같은 볼륨에 두 번째 봇
컨테이너를 붙이는 시험을 하지 않았다. 그 경우 `LEDGER_OWNED`로 exit 1이 되는
증거는 이전 라운드 `green-bot-docker-restart.log`(07:13Z, 이미지
`sha256:21487655…`)를 재사용한 것이다. 새 이미지에서 다시 실행한 결과가 아니다.

이 절을 쓸 때는 새 head의 CI가 없었다. 그 뒤 커밋 `dda3448`의 CI는 다음
절에 있다. run 41763180023(head `41fcdb8`)은 이 결과의 CI 증거가 아니다.
main 게시 시간, 실제 운영 TLS·HTTPS, Secret 작성, Argo 동기화, merge는
측정하거나 실시하지 않았다.

## Docker Hub 부트스트랩 이미지와 커밋 `dda3448` CI

커밋 `dda34482ed5106e90e7bcce358015e8cda0f7002`(트리 `78670798`)의 결과다.
아직 커밋하지 않은 Docker Hub 전환 변경(CI·매니페스트·문서)은 여기에 들어
있지 않다. 그 변경의 새 head CI는 아직 없다. 증거는
`_workspace/recheck-20261104/`에 있다.

| 검증 | 결과 | 출처 |
| --- | --- | --- |
| 게시 | `docker.io/kty1021/sample-app:dda3448…`, index `sha256:4e219077…`, linux/amd64 `c6fdf7f5…`, linux/arm64 `88b5cb22…` | 손으로 게시, `dockerhub-publication.json` |
| 공개·익명 pull | 공개 저장소. 로그인 없이 index, 두 arch의 manifest·config 수신, config `APP_VERSION`이 커밋 SHA | 위 기록, 09:37Z 익명 index 재조회에서 digest·arch 같음 |
| 게시 전 스캔 | 두 arch Trivy vuln·secret, CRITICAL 0, secret 0 | `dockerhub-publish/commit-*-scan.json` |
| 인증 스모크 | 게시한 두 이미지(amd64 `48ba4d72…`, arm64 `0c49a09b…`)에서 익명 주입 401·행 불변, 인증 봇 1건 커밋, 진단 200 | `phase3/hub-dda-{amd64,arm64}-auth.json` |
| PR CI run 41803670013 | head `dda3448`, `pull_request`, test·build job 성공 | `ci-dda3448.json` |

run 41803670013은 그 커밋의 `ci.yml`(GHCR 이름, amd64 한 개)로 돌았다. PR
실행이라 로그인·게시·GitOps 단계는 건너뛰었다. 그래서 Docker Hub 태그는 CI가
아니라 손으로 게시한 부트스트랩 이미지다. 재검수 이전 head `41fcdb8`의 run
41763180023과는 다른 실행이다.

게시한 이미지는 위 S1 절의 Docker 이미지(`sha256:46df9ad3…`)나 그 전에
만든 `review-…` 시험 빌드와 다르다. 위 인증 스모크는 커밋 트리에서 새로
빌드해 게시한 이미지로 다시 실행한 결과다.

## PR 단계 비차단 지적 처분

커밋 `efb34f1` 위에서 PR 전체 리뷰의 비차단 지적 6건을 처분한 결과다. 증거는
`_workspace/recheck-20261104/phase3/pr-dispositions/`에 있다. 이 변경의 새
CI는 아직 없다. 커밋·push 뒤에 실제 CI가 돌아야 확인된다.

| 검증 | 결과 |
| --- | --- |
| URL TLS 키 RED | 수정 전 실제 pg upgrade에서 `sslnegotiation=direct`와 CA를 주면 Node TLS 검증 해제 상태에서 `rejectUnauthorized:false`, CA 없음 |
| URL TLS 키 GREEN | `ssl` 접두 키·`uselibpqcompat`을 처음 생성·교체·env에서 거절, env `sslmode`는 읽고 제거, CA·검증 유지 |
| CI trace | stub docker로 step 셸을 돌린 trace. 실제 Docker는 실행하지 않음 |
| CI 변이 4종 | arm64 스캔·push·index 누락, 다른 저장소 push. 수정 전 시험은 모두 통과, 새 시험은 모두 실패 |
| action pin | 공식 태그를 `git ls-remote`·GitHub API로 조회한 commit SHA, Trivy는 로컬 스캔 이미지와 같은 index digest |
| Linux Node 22.23.4·PG17 | `npm test`, `npm run test:integration` 각 167건 중 통과 164, 실패 0, 건너뜀 3 |
| 호스트 bash 3.2 | Linux에서 건너뛴 CI trace 3건 포함 매니페스트·request-store 시험 42건 통과 |
| actionlint | `ci.yml` exit 0 |

Linux 시험 이미지(`node:22-alpine`)에는 bash가 없어 CI trace 3건을 이유와
함께 건너뛴다. GitHub ubuntu runner에는 bash가 있어 CI의 `npm test`에서는
돈다. 호스트 `npm test`의 봇 CLI 실패 4건은 macOS에 flock이 없어서이며
Linux 실행에서는 통과했다.

## 확인 한계

봇은 유한 기록을 보관하며 전체 한도에서 종료한다. 기본값은 10000건/8MiB로
1건/s에서 건수 기준 약 2시간 47분이다. 기록은 자동 삭제하지 않는다.

DB fencing·CDC 최종 일치·모든 replica 정지 확인은 별도 오케스트레이터의 책임이다.
진단 DB 건수는 최대1초 캐시다. 실제 배포에는 새 이미지 게시·GitOps 태그 교체,
환경별 Secret·진입점이 필요하다. 렌더와 로컬 테스트를 배포 완료로 해석하지 않는다.

S1 인증이 닫지 않는 위험은 [배포 안내](deployment.md#인증이-닫지-않는-위험)에
있다. 공개 HTTP 80, 인증 없는 진단·지표, 수명 없는 고정 토큰, 형식이 깨진
Bearer의 401 응답, ALB와 Pod 사이 평문 구간이 남는다.

claude-mem은 이 Codex 작업에서 사용하지 않았으며 git/로컬 작업 기록으로 대체했다.
하네스는 프로젝트 범위에 설치했고 전역 설정은 변경하지 않았다.
