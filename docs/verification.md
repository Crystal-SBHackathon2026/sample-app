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

## PR R1 제품 지적 세 건 보완 — 2026-11-04

기준 HEAD는 `8207ef51388d54d3410cceddf1f5bcbd1dfe61a1`이다. 사전 기록
`verify-sol-r1-high.md.meta.json`의 `finished`, exit 0과 H 재현 판정을
확인한 뒤 수정했다. 아래는 미커밋 보완의 새 결과이며, 이전 C3·CI의
167/167 결과를 이번 소스의 실행 결과로 재사용하지 않는다.
증거는 `_workspace/recheck-20261104/phase3/sol-pr1-fixes/`에 있다.

| 지적 | 원인과 처분 | 회귀 근거 |
| --- | --- | --- |
| H `SOL-PR1-H01` | 후속 POST의 거절을 요청 전체의 미저장 증거로 사용했다. 첫 POST의 확실한 거절과 검증된 GET의 내용 충돌만 실패를 확정한다. 나머지는 조회 후 pending, 상한에서 unknown으로 보존한다. | `prior uncertain POST survives later refusals and recovers late COMMIT`, `recovery GET 401 cannot settle an uncertain POST; age ends unknown`, `later POST refusals stop at attempt cap after final GET` |
| M `SOL-PR1-M01` | 외부 지연의 소수·비정상 값과 시각 덧셈이 재시작 검증을 깨뜨렸다. 유한한 0 이상 숫자는 밀리초 올림, 나머지는 무시한다. 지연은 기존 하한·시간 상한과 safe integer 덧셈 범위로 제한한다. HTTP 파서도 정규화한다. | `SDK retryAfterMs always persists a safe schedule that reopens`, `HTTP Retry-After parser returns safe nonnegative milliseconds` |
| M `SOL-R1-M01` | IP 접속에서 중첩 ssl.servername이 인증서 비교 대상을 바꿨다. 초기·교체 공통 verifiedTls에서 지정 자체를 거절한다. 직접 SDK 입력 경계의 M 분류를 유지한다. HTTP·env 우회가 발견됐다는 뜻은 아니다. | `IP TLS rejects servername overrides at entry, replace and defaults`, `real pg IP TLS upgrade preserves valid CA and rejects identity override` |

`attempts`는 전송 전에 영속 증가하며, 확실한 `WRITES_PAUSED` 응답에 한해서
그 시도만 환불한다. 이전 미확정 시도는 후속 거절·환불로 지우지 않는다.
ledger 필드·버전·상태 집합은 추가하지 않았다. 첫 POST 단독 400·409,
pause 뒤 첫 확실한 거절, 잘못된 2xx, 시도·시간 상한의 마지막 GET,
실제 GET 내용 충돌, 이전 미확정 POST 뒤 pause 환불도 새 회귀에 포함했다.

| 이번 직접 실행 | 결과와 한계 |
| --- | --- |
| Node | 작업 로컬 실행 파일의 v22.23.4 사용. 기본 셸 Node는 v26.4.0이므로 시험에는 쓰지 않았다. npm check에도 Node 22 PATH를 명시했다. |
| RED → GREEN | 원본 제품 파일을 `originals/`에 보존했다. 최초 RED는 새 봇 시험 31건 중 13건 실패, TLS 2건 실패였다. 최종 시험을 원본으로 재실행한 `red-tree/`도 봇 36건 중 13건·TLS 2건 실패했다. GREEN은 새 봇 36/36, 선택 TLS 12/12, 기존 봇 회귀 7/7이다. |
| 봇 실행 경계 | 실제 bot·HTTP adapter·ledger 저장/재시작 코드와 실제 파일 fsync·rename을 실행했다. macOS 로컬 실행은 `_workspace` 전용 소유 잠금 대역과 HTTP fetch 대역을 사용했다. 늦은 COMMIT의 가시성은 모의했으며 실제 PostgreSQL·Linux flock 재현은 아니다. 제품 회귀 파일은 잠금 대역을 포함하지 않아 Linux에서는 실제 ledger 잠금을 사용한다. |
| TLS 실행 경계 | 설치된 pg 8.23.1의 실제 IP upgradeToSSL → tls.connect 실행. 유효한 Node CA 원문 보존, rejectUnauthorized 강제, servername 미지정, 초기·교체 거절을 확인했다. TCP 연결·TLS 핸드셰이크·운영 인증서 접속은 실행하지 않았다. 기존 checkServerIdentity·URL TLS·env guard 시험도 선택 실행했다. |
| 검사 | npm run check, check-style.sh, git diff --check 성공. 스타일 스크립트는 Go 전용이며 JS 포맷터 검증이 아니다. JavaScript는 Google 원문의 4.3·4.4·5.1·5.6·6.2 조항을 직접 확인했다. |
| 실행 제약 | Docker API 소켓 권한 거부. 처음 실행한 request-store 파일 29건 중 27건 통과, 소켓 필요 시험 2건은 listen EPERM으로 실패했다. 이후에는 위의 소켓 불필요 선택 시험만 실행했다. 호스트 npm test 전체는 실행하지 않았다. |

동일 원인 감사는 제품 `packages/`에 한정했다. 예전의 terminal 단독 실패
계산과 retryAfterMs 직접 시각 덧셈 패턴은 0건이다. 비영 nextAttemptAt 생성은
정규화한 한 곳이며, 초기·교체의 makePool은 같은 TLS guard를 통과한다.
상세 검색 범위·출력은 `guards.json`에 남겼다.

실제 Linux Bash·Node 22·PG17 전체 시험 두 번, 새 pack 소비자, clean runtime은
부모의 후속 검증으로 남는다. 커밋·push·CI·PR 전체 검수나 배포 성공을 이번
보완의 완료 근거로 주장하지 않는다. PR 문서 LOW 수정도 부모가 담당한다.

## C5 TLS 부류·인증 설명 후속 보완 — 2026-11-04

TQ C5 R1의 meta `finished`, exit 0과 원문의 C/H 0건을 확인했다.
기준은 부모가 stage한 C5 tree `42017e4e`이며 index는 그대로 보존했다.
증거·원본 사본은 `_workspace/recheck-20261104/phase3/sol-pr1-followup/`에 있다.

M의 원인은 `servername`만 막고 동일한 검증·연결 대상 변경 부류를 남긴 것이다.
설치된 Node 22.23.4의 `getSessionServerIdentity`는 `servername` → `host` →
`socket._host` → `localhost`를 선택하고, 실제 인증서 이름 검사에도 이 값을
사용한다. pg 8.23.1은 SSL 옵션을 기존 host·socket 위에 병합한다.
따라서 공통 guard는 `servername`·`host`·`socket` 지정을 거절한다.
초기·교체·defaults에 own/inherited와 `undefined` 모두 적용한다.
기존 CA 보존·검증 강제·checkServerIdentity·URL/env guard는 유지했다.

프로브는 실제 pg upgradeToSSL → tls.connect에 전달된 최종 host를 반환한다.
이름 비교 대상은 포획한 옵션에 위 Node 선택 순서를 적용해 함께 반환한다.
초기·교체·defaults의 정상 대조는 모두 기대 IP, 유효 CA, 검증 활성화를
assert한다. socket 입력은 실제 소켓 없이 풀 생성 전에 거절되는지 검사한다.
드라이버 기본값과 환경 설정은 `finally`에서 복구한다.

| 이번 후속 직접 실행 | 결과·경계 |
| --- | --- |
| RED | 보존 C5 제품 사본 + 새 시험·관측 프로브에서 5건 중 4건 실패. host·socket의 누락된 거절과 host 변경을 확인했다. 정상 IP는 DNS SAN 설명에 이름 오류, host 변형은 초기·교체·defaults에서 이름 검사 통과였다. |
| GREEN | 소켓 불필요 TLS 선택 시험 15/15, 실패·skip 0. 세 키 × own/inherited × 값/undefined × 명시적 초기·교체 및 defaults 초기·교체의 48개 거절 경계를 포함한다. |
| 검사 | 작업 로컬 Node 22로 npm run check, check-style.sh, diff --check 실행. 스타일 스크립트는 Go 전용이다. |
| 실행 범위 | 실제 제품 guard·pg·tls.connect와 이름 검사 함수 사용. 풀·전송은 대역이며 TCP·TLS 핸드셰이크·PostgreSQL 접속은 이번에 실행하지 않았다. Docker 접근과 호스트 전체 flock suite도 반복하지 않았다. |

L은 봇 README와 배포 안내의 401·closed 설명을 정정했다. 첫 POST의 확실한
거절도 이전 미확정 POST가 없어야 전체 실패를 확정한다. 그 외에는 pending을
보존해 재조회하고 상한에서 unknown으로 남긴다. 인증 변경 전 수락된 POST의
늦은 COMMIT이 가능하며 unknown은 미저장 단정이 아니다. 봇 로직은 수정하지 않았다.

부모의 원 C5 증거는 Linux Bash·Node 22·PG17 두 suite 각 205/205,
새 pack 두 개·별도 앱의 실제 PG 1행과 bot commit 1건, 청정 이미지 인증이다.
`pr1-real-pg-counterexample/baseline-real-pg-v3.log`의 stored=true/failed와
`fixed-real-pg.log`의 stored=true/committed, GET401 대조군 pending도 원 C5
증거다. 이번 후속 소스의 새 전체 Linux·consumer·runtime 결과로 소급하지 않는다.
새 전체 실행과 같은 M/L 범위의 듀얼·보안/TQ 확인은 부모의 후속 작업이다.
