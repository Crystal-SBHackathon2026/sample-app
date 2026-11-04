# 본선 배포 안내

이미지: `ghcr.io/softbankhackathon2026/sample-app:<commit-sha>`.
`deploy.yaml`은 기존 DeploySpec 호환 입력이고, 직접 적용 가능한 산출물은
`k8s/`의 Kubernetes 매니페스트입니다. 예선 명세의 API group 이름은
렌더러 호환성 때문에 유지했습니다.

## 사전 준비

- 이 저장소의 독립 매니페스트는 hackathon namespace 사용.
- 기존 GitOps overlay는 AWS/local이 sample-app, onprem이 hackathon이다.
- 동일한 public.migration_demo DDL을 DB 관리자 계정으로 사전 적용.
- sample-app-db Secret의 database-url 키에 앱 전용 접속 문자열 준비.
- AWS는 sample-app-db-ca Secret의 ca.pem 키에 RDS CA PEM 준비.
- 앱 writer는 SELECT/INSERT만 부여. 대상 DB 앱 쓰기는 이전 제어가 허용할 때만 개방.
- 외부 라우터/Ingress에서 TLS 종단과 두 환경의 단일 공개 진입점 준비.
- 프라이빗 GHCR 이미지는 별도 imagePullSecrets 설정 필요.

리포지토리에 실접속 Secret을 저장하지 않습니다.
AWS overlay는 TLS 인증서를 검증하며 사설 CA 경로를 주입합니다.
onprem overlay의 DB_SSL=false는 사설 데모망용 기본값입니다.
온프렘 DB가 TLS를 제공하면 true와 해당 CA mount로 변경하세요.

## 이미지와 매니페스트

```bash
docker build --build-arg GIT_SHA="$(git rev-parse HEAD)" \
  -t ghost-sample-app:local .
kubectl kustomize k8s/overlays/aws
kubectl kustomize k8s/overlays/onprem
kubectl kustomize k8s/traffic-bot
```

세 kustomization의 `replace-with-commit-sha`를 게시된 동일 커밋 SHA로
교체한 후 검토·배포합니다. 이 저장소에서 실제 클러스터 적용은 하지 않았습니다.
표준 Service는 ClusterIP이며 공개 Ingress를 임의 생성하지 않습니다.

봇은 EKS에 한 개만 띄워 앱이 온프렘으로 이동해도 계속 유지합니다.
traffic-bot-target ConfigMap의 base-url에 단일 공개 진입점을 준비하고,
PVC에 ledger를 보관합니다. 예를 들어 대상 ConfigMap을 미리 준비합니다.

```bash
kubectl -n hackathon create configmap traffic-bot-target \
  --from-literal=base-url=https://your-demo-entrypoint.example
```

위 URL은 반드시 실제 단일 진입점으로 바꿉니다. 사설 CA HTTPS를 쓰면
NODE_EXTRA_CA_CERTS에 해당 PEM 파일을 주입하세요.
 실행 명령은 이미지 기본값 대신 봇 CLI입니다.
Replica는1, Recreate 전략입니다. 봇 시작은 stale lock 만료를 최대15초 기다립니다.

## GitOps 인계

관련 `SoftBankHackathon2026/gitops` 변경은 본선 이미지·DB Secret·readiness를
기존 Rollout과 AWS/local/onprem 오버레이에 연결합니다. sample-app CI는
이미지 게시 후 `GITOPS_TOKEN`이 있으면 해당 저장소의
`apps/sample-app/base/kustomization.yaml` 이미지 태그를 갱신합니다.
아직 본선 이미지 경로가 반영되지 않은 GitOps 설정에는 쓰지 않고 실패합니다.

두 저장소의 PR과 Secret을 함께 준비해야 합니다. 먼저 본선 이미지를
게시한 뒤 GitOps를 적용할 수 있도록 배포 담당자가 순서를 조율하세요.
GitOps 변경의 병합·이미지 태그 변경·Argo 동기화는 실제 배포를 일으킬 수 있습니다.
이번 작업은 로컬 렌더·이미지·HTTP 검증이며 실제 클러스터 적용은 수행하지 않습니다.

## 쓰기 정지와 확인

앱은 control.json ConfigMap 볼륨을 요청 시 읽습니다. 안정된 이름의 ConfigMap을
변경하면 kubelet 전파를 기다립니다. 변경이 즉시/동시에 반영되지는 않습니다.
각 replica의 상태를 확인하고 원본 DB 권한·세션도 차단해야 전환할 수 있습니다.
/readyz는 pause 중에도 DB 조회가 가능하면200이라 읽기 트래픽이 유지됩니다.
DB 장애 또는 잘못된 제어 파일에서는503이고 /healthz는 계속200입니다.

DeploySpec 경로는 DATABASE_URL과 DB_SSL_CA(PEM 본문)를 Secret에서
환경변수로 공급해야 합니다. 이전 렌더러의 Secret 이름 매핑도 확인하세요.
Kubernetes/Argo의 직접 매니페스트를 주 배포 경로로 사용합니다.

DeploySpec 호환 경로에는 runtime ConfigMap/볼륨 표현이 없어 파일 기반 실시간
pause가 연결되지 않습니다. 이 경로는 env 변경 후 재시작으로만 정지할 수 있으며,
실제 컷오버는 위의 K8s/Argo 매니페스트 또는 모듈 제어를 구현한 호스트를 사용합니다.
sslmode=require도 인증서·호스트를 검증합니다. 자기서명/사설 CA는 CA를 공급해야 하며
PGSSLROOTCERT와 DB_SSL_CA를 함께 주면 파일이 우선합니다.

## 봇 메모리와 보관 한도

라이브러리/CLI 기본값과 별개로256Mi 컨테이너 선언은10000건/8MiB를 한도로 둡니다.
Node22 컨테이너에10000건(약5.3MB)의 완료 기록을 넣고 추가 전송·metrics를 수행한
로컬 시험은 peak RSS129MiB, 약709ms였습니다. 전체 운영 부하 보장은 아닙니다.
1건/s에서 건수 한도는약2.8시간이므로 긴 시험은 기존 기록을 보관하고
별도 ledger/run으로 나눕니다. 큰 payload는 바이트 한도에 먼저 도달합니다.
루트 화면과 /api/info의 DB 건수는1초 캐시이며 /readyz는경량쿼리입니다.
