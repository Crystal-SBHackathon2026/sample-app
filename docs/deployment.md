# 본선 배포 안내

이미지: `docker.io/kty1021/sample-app:<commit-sha>`(Docker Hub 공개 저장소,
amd64·arm64를 묶은 manifest). 앱과 봇이 같은 이미지를 쓴다. 이 문서는 배포
선언과 운영 순서다. 이 작업에서 실제 클러스터 적용, 운영 DB 변경, merge는
하지 않았다.

## 배포 정본과 예시

- **본선 정본은 `SoftBankHackathon2026/gitops`다.** 앱은
  `apps/sample-app`(Argo Rollout), 환경별 Application은 `argocd/`에 있다.
- 이 저장소의 `k8s/`는 독립 적용 예시다. 본선에서 쓰지 않는다.
- `deploy.yaml`은 review-service 렌더러의 입력(DeploySpec)이다. 렌더러가
  gitops `apps/sample-app/overlays/aws/`를 만든다.
- Argo가 관리하는 namespace에 `k8s/`를 함께 적용하지 않는다. 특히
  `k8s/`(hackathon, Deployment·Service `sample-app`, 생성 ConfigMap)와 gitops
  onprem(hackathon, Rollout·Service `sample-app`)은 이름이 겹친다.

## AWS 적용 순서

뒤 층이 앞 층을 덮는다. Argo Application `sample-app-aws`의 첫 소스는 3층이다.

1. `apps/sample-app/base`: 사람이 관리. Rollout·Service·제어 ConfigMap.
1. `apps/sample-app/overlays/aws`: 렌더러 생성물. namespace `sample-app`,
   replicas 3, env, probe, 리소스, ALB Ingress. 손으로 고치지 않는다.
1. `apps/sample-app/runtime/aws`: 사람이 관리하는 wrapper. DB Secret 참조,
   `PGSSLMODE=verify-full`, CA mount, 제어 파일 env·mount, readiness
   timeout 3초, AWS 제어 초기값 `writes_paused: true`.

렌더러는 컨테이너 0번을 통째로 새로 만들고, Secret 이름을 `<app>-secrets`로
고정하며, ConfigMap·Secret volume을 표현하지 못한다. 그래서 DB·CA·제어 파일은
`deploy.yaml`이 아니라 3층에 둔다.

wrapper의 첫 두 JSON6902 op는 `test`다. 컨테이너 0번 이름이 `sample-app`이고
pod volumes가 `control` 하나뿐이어야 build가 된다. `deploy.yaml`에 storage를
넣거나 렌더러가 구조를 바꾸면 build가 실패한다. 그때 Argo 동기화도 실패하고
옛 버전이 계속 서비스할 것으로 추론한다(클러스터 미확인).

`deploy.yaml`을 바꾸거나 렌더러가 다시 렌더했으면 다음을 확인한다.

```bash
kubectl kustomize apps/sample-app/runtime/aws   # gitops 저장소에서
```

## 값 차이표

| 항목 | `k8s/` 독립 예시 | gitops 정본 |
| --- | --- | --- |
| 정본 여부 | 예시, 본선 미사용 | 본선 정본 |
| namespace | aws·onprem 모두 hackathon | aws sample-app, onprem hackathon, local sample-app |
| 종류·replicas | Deployment 2 | Rollout. aws 3(`deploy.yaml`), onprem·local 2 |
| memory req/limit | 128Mi/256Mi | aws 128Mi/256Mi, onprem·local 64Mi/128Mi. 앱 실측 없음 |
| DB TLS | aws `DB_SSL=true`+CA, onprem `false` | aws `PGSSLMODE=verify-full`+CA, onprem·local `disable` |
| onprem `DEPLOY_ENV` | onprem | local. 팀 결정 필요 |
| 제어 초기값 | false | base false, aws wrapper true |
| 요청 API 인증 | `required`+Secret(optional) | aws wrapper·onprem `required`+Secret(optional), local 없음(open) |
| ALB tags | 해당 없음 | 렌더러 카탈로그 값 `Project=oneaction,…,Env=dev` |

ALB tags는 렌더러가 카탈로그에서 넣는다. 본선 전용 태그가 필요하면
review-service 카탈로그를 바꿔야 하며 이 작업의 범위 밖이다.

## 사전 준비

- 공유 DB의 테이블·역할은 팀의 `migration-db-init`이 정본이다. 이 앱은 운영
  DB에 DDL을 실행하지 않는다. 독립 DB에서만 `schema.sql`(`npm run db:init`)을
  관리자 연결로 적용한다.
- 앱 역할은 `public.migration_demo`의 SELECT·INSERT만 가진다.
- Secret: onprem `hackathon/sample-app-db`, AWS `sample-app/sample-app-db`의
  `database-url` 키, AWS `sample-app/sample-app-db-ca`의 `ca.pem` 키.
  요청 API 토큰 `sample-app-api-token`의 `token` 키는 아래 요청 API 인증 절을
  따른다.
- 저장소에 실접속 Secret을 넣지 않는다. 이미지는 공개 저장소라
  imagePullSecrets 없이 받는다. Docker Hub 익명 pull 제한에 걸리는지는
  클러스터에서 확인하지 않았다.

## DB TLS 정책

`request-store`는 `require`·`verify-ca`·`verify-full`을 모두 인증서 검증
(`rejectUnauthorized: true`)과 Node 기본 호스트명 검증으로 해석한다. libpq와
의미가 다르다. libpq의 `require`는 인증서를 검증하지 않고 `verify-ca`는
호스트명을 보지 않지만, 이 앱은 둘 다 검증한다. 검증을 약하게 하는 설정은
제공하지 않는다.

- AWS: `sample-app-db-ca`에 RDS 서버 인증서를 검증할 CA를 넣는다. 인증서의
  SAN이 `DATABASE_URL`의 호스트와 맞아야 한다.
- onprem: 플랫폼 PostgreSQL이 비TLS 연결을 허용하는지 배포 전에 확인한다.
  허용하지 않으면 CA mount와 `verify-full`로 바꾸고 SAN을 확인한다.
- 실제 운영 TLS 접속은 이 작업에서 검증하지 않았다.

## 요청 API 인증

`/api/requests`의 POST와 GET은 공유 Bearer 토큰으로 보호한다. 화면 `/`,
`/healthz`, `/readyz`, `/api/info`, `/metrics`는 인증 없이 열려 있다. 응답과
모드 판정은 [API 계약](api.md)에 있다.

| 대상 | `REQUEST_API_AUTH` | 토큰 env |
| --- | --- | --- |
| gitops `runtime/aws` wrapper | `required` | `REQUEST_API_TOKEN` ← `sample-app-api-token`/`token`, `optional: true` |
| gitops `overlays/onprem` | `required` | 위와 같음 |
| `k8s/base` 독립 예시(aws·onprem overlay가 상속) | `required` | 위와 같음 |
| `k8s/traffic-bot` | 해당 없음 | `BOT_API_TOKEN` ← 같은 Secret, 필수 |
| gitops `overlays/local` | 없음(open) | 없음 |

- 인증 값은 생성물 `deploy.yaml`과 gitops `overlays/aws`에 넣지 않았다. AWS
  값은 wrapper의 JSON6902 `add`로만 넣는다.
- gitops `overlays/local`은 개발용이라 open으로 둔다. 시작 때 warn 로그가
  남는다. 매니페스트는 localhost 바인딩을 보장하지 않는다. k3d를
  `-p "8081:80@loadbalancer"`로 만들면 모든 인터페이스에 열려 같은 LAN에서
  익명 쓰기가 된다. `-p "127.0.0.1:8081:80@loadbalancer"`로 만들고 공개
  진입점이나 공유망에 연결하지 않는다.
- 인증 env는 gcp overlay, gitops `base/rollout.yaml`, argocd에 넣지 않았다.
  gcp overlay는 이 PR 전체에서 바뀌지 않았다. 다만 PR 전체로는
  `base/rollout.yaml`의 이미지 경로·control volume·readiness timeout과
  `argocd/sample-app-aws.yaml`의 소스 경로(`runtime/aws`)가 바뀌었다.

앱의 Secret 참조가 `optional: true`인 이유는 진단이다. Secret이 없어도 pod는
뜨고 `/api/requests`만 503 `API_AUTH_UNCONFIGURED`로 닫힌다. 화면과 health는
살아 있어 원인을 볼 수 있다. 봇은 토큰 없이는 쓸모가 없으므로 Secret이 없으면
`CreateContainerConfigError`로 뜨지 않는다.

### 현재 HTTP 80에서의 fail-closed

공개 진입점은 아직 HTTP 80이다. HTTPS, 도메인, ACM 인증서, Secret 작성은
외부 전제이며 이 작업에서 하지 않았다. 이 선언을 지금 적용하면 쓰기는 다음처럼
닫힌다. HTTPS가 설치됐다는 뜻이 아니다.

- 봇: `base-url`이 `http://`이면 토큰 전송을 거절하고
  `INSECURE_TOKEN_TRANSPORT`로 종료한다. ledger 생성과 요청 전에 멈춘다.
  예외는 hostname이 정확히 `127.0.0.1`·`[::1]`인 로컬 시험뿐이다.
- 서버: Secret이 없으면 익명 POST·GET이 503, Secret이 있으면 401이다.
- 쓰기는 HTTPS와 공유 Secret을 모두 갖춘 뒤에야 열린다.

### 인증 관측

- 쓰기 정지 중에도 정상 토큰의 GET은 동작한다. 익명 GET은 계속 거절된다.
- `app_request_api_auth_mode{mode}`는 현재 모드만 1이다. 시작 때 정해지므로
  설정이나 Secret을 바꾸면 재시작해야 반영된다.
- `app_request_api_auth_rejected_total{reason}`은 `unauthorized`(401)와
  `unconfigured`(503) 거절 수다. 요청마다 로그를 남기지 않는다.
- 이전 미확정 POST가 없는 첫 POST는 토큰이 틀리면 `failed`·`HTTP_401`이 된다.
  이전 POST가 미확정이면 후속 POST나 복구 GET의 401로 실패를 확정하지 않는다.
  `pending`을 보존하며 재조회하고 상한에서 `unknown`으로 남긴다.
  `traffic_bot_requests_total{state="failed"}`가 늘면 토큰부터 본다. 1건/s면
  약 2시간 47분에 10000건 상한이 찬다.
- 앱이 closed면 봇은 503을 모호한 응답으로 보고 GET으로 확인한다. 확인하지
  못하면 `pending`을 거쳐 예산이 끝날 때 `unknown`이 된다. 이 `unknown`은
  커밋 여부를 확인하지 못했다는 뜻이다. closed 전 수락된 POST는 늦게 커밋될
  수 있으므로 미저장을 단정하지 않고 수동 정합성 확인 대상으로 보존한다. `unknown`이
  늘면 Pod마다 `mode="closed"`와 Secret 존재부터 확인한다.

### 9단계 전 선행 조건

외부 작업이며 이 작업의 완료 주장에 넣지 않는다.

1. 공개 진입점에 HTTPS를 붙인다. 도메인과 인증서는 팀이 정한다.
1. AWS `sample-app`, 온프렘 `hackathon`, 봇 namespace에 같은 값의
   `sample-app-api-token`(키 `token`)을 만든다. 값은 32자 이상 b64token
   하나뿐인 파일에서 읽는다. 파일 끝에 줄바꿈이 있으면 토큰 형식 위반으로
   앱이 closed가 된다. 값을 명령행 literal(`--from-literal`)로 넣거나
   화면·로그에 출력하지 않는다.

    ```bash
    kubectl -n sample-app create secret generic sample-app-api-token \
      --from-file=token=/secure/request-api-token
    ```

    클러스터마다 값을 출력하지 않고 digest로 같은지 비교한다.

    ```bash
    kubectl -n sample-app get secret sample-app-api-token \
      -o jsonpath='{.data.token}' | shasum -a 256
    ```

1. 봇 `traffic-bot-target`의 `base-url`을 `https://`로 바꾼다.
1. AWS와 온프렘 모두 Rollout이 완전히 승격됐는지(모든 replica가 새
   revision) 확인한다. 그다음 **Pod마다** 모드가 `enforced`이고 인증 GET이
   통과하는지 본다. Service나 LB를 거친 한 번의 확인은 한 Pod만 본다.

    ```bash
    ns=hackathon   # AWS 는 sample-app
    for pod in $(kubectl -n "$ns" get pods -l app=sample-app -o name); do
      kubectl -n "$ns" exec "$pod" -- node -e '
        const base = "http://127.0.0.1:8080";
        const headers = {authorization: `Bearer ${process.env.REQUEST_API_TOKEN}`};
        const id = "00000000-0000-4000-8000-000000000000";
        Promise.all([
          fetch(`${base}/metrics`).then((r) => r.text()),
          fetch(`${base}/api/requests/${id}`, {headers}).then((r) => r.status),
        ]).then(([text, status]) => console.log(
            /^app_request_api_auth_mode\{[^}]*mode="enforced"[^}]*\} 1$/m
                .test(text), status));'
    done
    ```

    Pod마다 `true 404`(없는 ID)를 기대한다. 401·503이면 그 Pod는 아직 인증을
    통과시키지 않는다. 토큰은 Pod의 env 안에만 있고 명령행·셸 이력에 남지
    않는다.
1. AWS와 온프렘의 모든 Pod가 `true 404`를 낸 뒤에만 AWS `control.json`을
   false로 바꾸고 봇을 재개한다. 한 Pod라도 통과하지 않으면 봇을 재개하지
   않는다.

공개 진입점에서 확인할 때는 HTTPS와 헤더 파일만 쓴다. 토큰을 명령행, 셸
이력, URL, 쿠키에 넣지 않고 `http://` 주소로 보내지 않는다.

```bash
# /secure/api-auth-header: 한 줄 "Authorization: Bearer <토큰>", 권한 600
curl -sS -o /dev/null -w '%{http_code}\n' -H @/secure/api-auth-header \
  https://your-demo-entrypoint.example/api/requests/00000000-0000-4000-8000-000000000000
```

### 토큰 교체

1. 봇을 멈춘다: `kubectl -n hackathon scale deployment/traffic-bot --replicas=0`
1. 모든 namespace의 Secret을 새 값으로 바꾼다.
1. 앱을 재시작한다(Rollout restart). 토큰은 시작 때만 읽는다. AWS·온프렘
   Rollout이 완전히 승격되고 Pod마다 위 확인이 통과할 때까지 기다린다.
1. 모든 Pod가 통과한 뒤에만 봇을 replicas 1로 되돌린다. run_id와 ledger는
   그대로 쓴다.

봇이 옛 토큰으로 401을 받아 레코드를 `failed`로 소진하는 창을 만들지 않으려는
순서다. 클러스터에서 실행하지 않았다.

### 인증 롤백

인증이 없는 옛 이미지로 되돌리거나 auth env를 빼면 앱이 open이 되어 익명
쓰기가 다시 열린다. 공개된 상태 그대로 롤백하지 않는다.

1. 먼저 모든 writer를 멈춘다. 봇 scale 0, 해당 환경 `control.json`을 true로
   Git에 커밋·동기화, Pod마다 `writes_paused=true`·`writes_in_flight=0` 확인.
1. 이미지(소스)와 매니페스트 env를 같은 묶음으로 되돌린다. 되돌린 뒤 Pod마다
   모드를 다시 확인한다.
1. open으로 돌아갔다면 공개 진입점을 막기 전에는 쓰기를 재개하지 않는다.

클러스터에서 검증하지 않았다.

### 인증이 닫지 않는 위험

- 공개 `/readyz`는 요청마다 제어 파일과 DB pool을 쓴다. `/api/info`와 `/`도
  제어 파일과 1초 캐시 조회를 쓴다. L7 flood로 pool 경합과 readiness 실패가
  여전히 가능하다. 속도 제한과 WAF는 외부 edge의 책임이다.
- TLS는 ALB에서 끝난다. ALB에서 Pod까지와 클러스터 안 프록시 구간은 평문이다.
- 고정 공유 토큰이라 만료, scope, audience가 없다. 유출되면 교체할 때까지 같은
  Secret을 쓰는 AWS·온프렘의 `/api/requests` 읽기와 쓰기를 모두 사칭할 수
  있다. 대응은 교체 절차뿐이다.
- 공개 `/metrics`에서 인증 모드와 거절 수가 보인다.
- 서버는 전송 계층을 검사하지 않는다. HTTP로 온 정상 토큰도 받는다. 토큰을
  HTTP로 보내지 않는 책임은 클라이언트(봇의 시작 거절, 운영자)에 있다.
- 형식이 깨진 Bearer 요청에도 RFC 6750 권고인 400 `invalid_request` 대신
  401 `invalid_token`을 준다.
- DB에 직접 쓰는 워커는 이 인증과 무관하다. RFC 6750 전부를 준수한다고
  주장하지 않는다.

## 이미지 게시와 롤백 순서

1. sample-app PR 병합 → CI가 시험 뒤 amd64·arm64를 빌드하고 둘 다 스캔한
   다음 `<sha>-amd64`·`<sha>-arm64`와 두 arch를 묶은 `<sha>` manifest를
   Docker Hub에 게시한다. `latest`는 쓰지 않는다
   ([ADR-0003](decisions/2026-11-04-ci-gate-after-db-tests.md)).
1. 같은 CI가 gitops base `newTag`를 갱신한다. gitops PR이 아직 병합되지
   않아 base 이미지가 Docker Hub 경로가 아니면 태그를 바꾸지 않고 의도대로
   실패한다.
1. 게시된 SHA가 Docker Hub에 있는지 읽기 전용으로 확인한다. gitops PR의
   `newTag`는 그 SHA여야 하고, 사용자 승인 후 병합한다. GHCR에만 게시된 옛
   태그는 Docker Hub에 없다(ImagePullBackOff).
1. gitops PR의 초기 `newTag`는 앱 커밋
   `dda34482ed5106e90e7bcce358015e8cda0f7002`다. 이 태그는 2026-11-04 Docker
   Hub 공개 저장소에 게시됐다. amd64·arm64를 묶은 index digest는
   `sha256:4e219077ff61e90dab00762e81e1ab97bc4344b06a9dc9af2f9ec19aade0f41b`다.
   로그인 없이 index와 두 arch의 manifest·config를 받을 수 있음을 확인했다.
   CI가 아니라 그 커밋 트리에서 손으로 빌드·스캔(Trivy CRITICAL 0, secret
   0)해 게시한 부트스트랩 이미지다. 다음 태그부터는 병합 뒤 main CI가
   게시한다. 이 이미지는 `dda3448` 코드이며, 아직 커밋하지 않은 Docker Hub
   전환 변경을 검증한 결과가 아니다.
1. CI의 외부 action은 commit SHA로, Trivy 이미지는 digest로 고정했다.
   GitOps는 아직 Docker Hub 태그를 참조하며, 태그는 다시 push하면 바뀔 수
   있다. 게시 토큰 범위 미확인과 digest 전환 이연은
   [ADR-0003](decisions/2026-11-04-ci-gate-after-db-tests.md#게시-공급-경로)에
   있다.
1. 쓰기 정지 중에는 이미지 rollout을 하지 않는다. 카나리 분석이 5xx를 실패로
   볼 수 있다.
1. 롤백은 이미지 태그, wrapper, Argo Application path를 함께 되돌린다.
   테이블과 봇 ledger PVC는 남는다. 인증이 없는 이미지로 되돌리면 공개
   API가 열리므로 "인증 롤백" 순서를 먼저 따른다. 클러스터에서 검증하지
   않았다.

## 쓰기 정지와 readiness

앱은 `APP_CONTROL_FILE`(ConfigMap `sample-app-control`의 `control.json`)을
요청마다 읽는다. ConfigMap 전파는 즉시·동시가 아니다. Argo `selfHeal` 때문에
`kubectl patch`로 바꾼 값은 Git 값으로 돌아갈 수 있으니 Git에서 바꾼다.

- 제어 파일이 깨졌거나 `{"writes_paused":"true"}`처럼 형식이 틀리면 쓰기를
  정지한다(fail-closed). POST는 503 `WRITES_PAUSED`다.
- readiness는 DB 조회 가능 여부만 본다. 제어 이상으로 `/readyz`를 내리지
  않는다. 내리면 모든 replica가 Endpoints에서 빠져 조회·`/api/info`까지
  끊기는데, 쓰기는 이미 정지돼 있어 얻는 안전이 없다.
- 제어 이상은 `/api/info`의 `write_control.healthy=false`, 지표
  `app_write_control_healthy` 0, 상태가 바뀔 때 한 번의 warn 로그로 드러난다.
- DB 장애에서는 `/readyz` 503, `/healthz`는 계속 200이다.

파일 정지는 그 프로세스의 쓰기만 막는다. DB 권한 차단, 진행 중 트랜잭션
정리, CDC 완료 검증을 대신하지 않는다.

## 기존 INSERT 워커와의 공존

팀의 `db-insert-worker`, `migration.cutover`, `migration-db-init`은 바꾸지
않는다. 봇은 워커와 함께 돈다.

- run_id를 나눈다. 봇은 `ghost_bot_forward_001`, 워커는 `forward_NNN`·
  `return_NNN`이다. 봇 ledger를 잃었으면 새 run_id로 시작하고, 지운 ledger의
  run_id는 다시 쓰지 않는다.
- 봇의 phase는 프로세스 범위다. 바꿀 때는 정상 종료(SIGTERM, 잠금 해제) →
  `BOT_PHASE` 변경 → 재기동 순서다. 대기 중이던 기록은 생성 때의 phase를
  유지한다.

정방향 수동 전환 순서(번호는 Notion 이전 계획 표):

1. 5단계: cutover가 워커를 대기시킨다. 운영자는 onprem `control.json`을
   `{"writes_paused":true}`로 Git에 커밋하고 동기화한다.
1. cutover `--approve` 전에 **모든 replica**의 `/api/info`에서
   `writes_paused=true`와 `writes_in_flight=0`을 확인한다. Service를 거치면
   한 Pod만 보므로 Pod마다 확인한다.

    ```bash
    for pod in $(kubectl -n hackathon get pods -l app=sample-app -o name); do
      kubectl -n hackathon port-forward "$pod" 18080:8080 >/dev/null &
      pf=$!; sleep 2
      curl -s http://127.0.0.1:18080/api/info; echo
      kill "$pf"
    done
    ```

1. 이 구간에서 봇은 503+미커밋 응답을 받아 `pending`으로 보존한다.
1. 6단계: cutover의 `migration_app` 권한 회수(REVOKE)가 실제 차단이다. 외부
   도구의 책임이며, API 정지만으로 차단했다고 주장하지 않는다.
1. 9단계: 공개 진입점 전환(외부 인프라) 뒤 봇을 `BOT_PHASE=aws_live`로
   재기동하고 AWS `control.json`을 false로 바꾼다. 그 전에 위 "9단계 전
   선행 조건"(HTTPS, 같은 Secret, Pod별 인증 확인)을 모두 마친다.

cutover의 자동 행 수 게이트는 모든 writer의 합계다(run_id 필터 없음). 워커
단독 생산 증거로 읽지 않는다. writer별 증거는 run_id별 증분과 각 ledger를
대조해 따로 남긴다. 워커 단독 기준을 채우기 전에는 다음 전환을 승인하지
않는다.

```sql
SELECT run_id,
       count(*) AS row_count,
       count(DISTINCT request_no) AS distinct_request_no,
       count(*) - count(DISTINCT request_no) AS duplicated
FROM public.migration_demo
WHERE run_id IN ('forward_001', 'ghost_bot_forward_001')
GROUP BY run_id;
```

수락 조건: run_id마다 `duplicated = 0`, 봇과 워커의 run_id 교집합 0, 전환
뒤 onprem INSERT 거절. 대상 DB의 `public.migration_demo`가 `schema.sql`의
6필드와 같고 `migration_app`에 SELECT·INSERT 권한이 있어야 한다.

## 트래픽 봇 운영

봇 선언은 `k8s/traffic-bot/`에 있다. replicas 1, Recreate, RWO PVC다.
`traffic-bot-target` ConfigMap의 `base-url`에 단일 공개 진입점을 넣는다.

```bash
kubectl -n hackathon create configmap traffic-bot-target \
  --from-literal=base-url=https://your-demo-entrypoint.example
```

위 URL은 실제 진입점으로 바꾼다. 사설 CA HTTPS면 `NODE_EXTRA_CA_CERTS`에
PEM 파일을 주입한다. 봇은 `BOT_API_TOKEN`(Secret `sample-app-api-token`)이
필수다. 토큰이 있는데 `http://` 진입점이거나 `NODE_TLS_REJECT_UNAUTHORIZED=0`
이면 `INSECURE_TOKEN_TRANSPORT`로 시작을 거절한다.

ledger의 단일 writer는 `.owner.lock` 파일의 커널 flock으로 보장한다
([ADR-0002](decisions/2026-11-04-ledger-kernel-lock-and-limits.md)).

| 상황 | 동작 |
| --- | --- |
| SIGTERM | 잠금 해제 → Recreate가 만든 새 Pod가 획득 |
| 같은 Pod 안 crash·OOM | 커널이 잠금 해제 → kubelet 재시작 → 자동 획득 → pending 처리 |
| SIGSTOP·hang | 새 writer 거절. liveness가 컨테이너를 죽이면 회복(클러스터 미확인) |
| 노드 장애 | 옛 노드 종료·fencing 확인 뒤에만 볼륨 이동(외부 책임) |

잠금 시작 실패 코드는 `LEDGER_OWNED`, `LEDGER_LOCK_UNSUPPORTED`,
`LEDGER_LEGACY_LOCK` 세 가지다. `LEDGER_LOCK_LOST`는 시작 거절이 아니다.
실행 중 다음 ledger 저장 직전에 잠금 파일의 교체·삭제를 발견하면 그 저장을
버리고 fatal로 멈춘다(요약 `fatal`, 종료 코드 1). 토큰 설정 거절은
`BOT_API_TOKEN_INVALID`와 `INSECURE_TOKEN_TRANSPORT`이며 URL과 토큰 값은
출력하지 않는다. 잠금 지원 범위는 Linux 단일
노드의 로컬 FS 또는 RWO 블록 볼륨이다. NFS·EFS·RWX와 cross-node 강제
detach는 보장 밖이다.

지표 이름은 유지한다. `traffic_bot_requests_total{state}`는 counter가 아니라
현재 ledger의 상태별 건수(gauge)다. `traffic_bot_attempts_total{kind}`는
counter이며 `write_errors`·`generation_blocked` 같은 사건 수도 센다.

## legacy 잠금 복구

proper-lockfile을 쓰던 옛 봇에서 처음 올릴 때만 필요하다. 새 봇이
`LEDGER_LEGACY_LOCK`으로 시작을 거절하면 옛 잠금 디렉터리
`/data/ledger.lock`이 남은 것이다. 새 봇끼리의 crash 재시작에는 이 절차가
없다.

1. `kubectl -n hackathon scale deployment/traffic-bot --replicas=0`
1. 옛 봇 Pod가 모두 종료됐는지 확인한다. 응답 없는 노드에 붙어 있던
   볼륨은 그 노드의 종료·fencing을 확인하기 전에 옮기지 않는다.
1. `kubectl apply -f k8s/traffic-bot/legacy-lock-recovery-job.yaml`
1. Job 로그에서 `REMOVED` 또는 `NOOP`을 확인하고 Job을 지운다.
1. 새 이미지로 Deployment를 replicas 1로 되돌린다.

Job(`node:22-alpine`, UID/GID 1000)은 `/data/ledger.lock`이 symlink가 아닌
빈 디렉터리일 때만 `rmdir`한다. `ledger.json`과 새 잠금 파일
`/data/ledger/.owner.lock`은 건드리지 않는다. 그 밖의 상태면 아무것도 지우지
않고 실패한다. 합성 볼륨에서 다섯 경우를 시험했고 실제 클러스터에서는 실행하지
않았다. Job은 kustomization에 넣지 않아 자동 적용되지 않는다.

## GCP 배포 조건

`argocd/sample-app-gcp.yaml`은 아직 적용하지 않는다(파일 3행, GKE 미등록).
이 작업은 gcp overlay를 바꾸지 않았지만 base 변경이 gcp 렌더에 들어간다.

- 이미지 조직 경로, 제어 ConfigMap·volume·mount, readiness timeout 3초.
- gcp overlay는 env를 통째로 바꾸므로 `DATABASE_URL`이 없다. DB API는 503이고
  readiness는 `/healthz`라 Pod는 Ready다.

DB·Secret·readiness(`/readyz`)·`newTag` 결정을 마치기 전에는 GCP
Application을 활성화하지 않는다.

## 봇 메모리와 보관 한도

기본 상한은 라이브러리·CLI·매니페스트 모두 10000건/8MiB다. 1건/s에서
건수 상한은 약 2시간 47분이다. 이론값이며 장시간 운영 보장이 아니다. 긴
시험은 기존 기록을 보관하고 새 ledger와 새 run_id로 나눈다. 큰 payload는
바이트 상한에 먼저 닿는다.

이전 라운드의 로컬 시험(Node22 컨테이너, 완료 기록 10000건 약 5.3MB)은 peak
RSS 129MiB, 약 709ms였다. 256Mi 컨테이너 선언의 근거이며 운영 부하 보장은
아니다. 루트 화면과 `/api/info`의 DB 건수는 1초 캐시, `/readyz`는 경량
쿼리다.

## See also

- [API 계약](api.md)
- [구현 검증 기록](verification.md)
- [ADR-0002 ledger 잠금과 상한](decisions/2026-11-04-ledger-kernel-lock-and-limits.md)
- [ADR-0003 CI 게이트](decisions/2026-11-04-ci-gate-after-db-tests.md)
