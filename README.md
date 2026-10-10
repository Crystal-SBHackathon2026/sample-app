# sample-app

배포 시스템 데모용 샘플 웹앱입니다. 화면과 `/api/info`에 **어느 환경(로컬·AWS·GCP)이 응답했는지** 표시합니다.

| 경로 | 설명 |
| --- | --- |
| `/` | 응답한 환경·버전·기동 시각 표시 |
| `/healthz` | 헬스체크 (Kubernetes probe, 배포 후 동작 확인) |
| `/api/info` | 환경 정보 JSON |
| `/metrics` | 프로메테우스 지표 (요청 수·지연·프로세스 상태) |

## PR 하나가 배포까지 가는 길

이 레포에 PR을 올리면 사람 손 없이 배포까지 갑니다. 약 5분 20초 걸립니다.

```
PR 올림
  → AI가 deploy.yaml 을 검토 (위험한 설정이면 막거나 고친다)
  → 통과하면 커밋 상태 review-service/verify = success
  → CI 통과 + 그 상태가 필수 체크라서 자동 병합
  → 이미지 빌드 · Trivy 검사 · GHCR 푸시
  → GitOps 레포의 이미지 태그 자동 갱신
  → Argo CD가 30초 안에 감지
  → 카나리 50% → 응답 확인 60초 → 100%
```

**검토를 통과하지 않은 커밋은 `main` 에 병합되지 않습니다.** 검토가 `needs_human` 으로 멈추거나 거절되면 상태가 `failure` 가 되고, 사람이 검토 없이 병합하려 해도 상태가 없어서 막힙니다.

## 실행
```bash
npm install
npm test
npm start   # http://localhost:8080
```

## 환경변수
| 이름 | 설명 |
| --- | --- |
| `DEPLOY_ENV` | local / aws / gcp |
| `DEPLOY_REGION` | busan-local / ap-northeast-2 / asia-northeast1 |
| `APP_VERSION` | 표시할 버전. **직접 넣지 않아도 된다** — CI가 빌드할 때 커밋 SHA를 이미지에 구워 넣는다 (`Dockerfile` 의 `ARG GIT_SHA`) |
| `FAIL_RATE` | 데모용 장애 주입 비율 (0~1). 카나리 자동 롤백 시연에 사용 |
| `HEALTH_FAIL` | 데모용 배포 실패 주입 (`true`면 헬스체크 503). 헬스체크 자동 롤백 시연에 사용 |

## CI (GitHub Actions)
테스트 → 이미지 빌드 → Trivy 취약점 검사 → (main) GHCR 푸시 → GitOps 레포 이미지 태그 갱신

## 배포 방식 (카나리)
새 버전은 한 번에 전부 바뀌지 않습니다.

```
새 이미지 → 50% (복제본이 2개면 새 버전 1개 + 옛 버전 1개)
         → 60초 동안 /api/info 응답 확인 (10초마다 6번)
         → 멀쩡하면 100%, 계속 틀리면 중단하고 되돌림
```

검토를 통과하지 않은 커밋은 `main` 에 병합되지 않습니다. 검토 결과가 커밋 상태 `review-service/verify` 로 기록되고, 그것이 브랜치 보호의 필수 체크입니다.

화면의 **기동 시각**으로 파드가 실제로 교체됐는지 확인할 수 있습니다. 단계와 확인 기준은 GitOps 레포의 `apps/sample-app/base/` 에 있습니다.

## 지표 (`/metrics`)

Grafana 의 `apps/` 폴더에서 봅니다. 30초마다 긁습니다.

| 이름 | 무엇 |
| --- | --- |
| `http_requests_total` | 요청 수. 라벨 `method` · `route` · `status` |
| `http_request_duration_seconds` | 요청 처리 시간 (히스토그램) |
| `process_*` · `nodejs_*` | 힙, 이벤트 루프 지연, CPU 등 기본 지표 |

세 가지를 일부러 그렇게 했습니다.

- **라벨에 커밋 SHA 를 넣지 않습니다.** 넣으면 배포마다 시계열이 새로 생겨 Prometheus 메모리를 먹습니다. "지금 뜬 게 어느 커밋인지"는 `kube_pod_container_info` 의 이미지 태그로 봅니다
- **경로는 매칭된 라우트 이름만** 씁니다. 들어온 URL 을 그대로 쓰면 없는 경로를 긁는 요청 하나하나가 새 시계열이 됩니다. 매칭 안 되면 `route="unmatched"` 하나로 모입니다
- **`/metrics` 자체는 세지 않습니다.** 30초마다 긁히니 세면 에러율·지연 계산을 전부 덮어씁니다

앱 포트와 **같은 포트**로 냅니다. `deploy.yaml` 의 `runtime.port` 는 하나뿐이고 overlay 는 렌더러가 다시 만들기 때문에, 포트를 더 뚫으려면 명세 형식부터 바꿔야 합니다. 공개 주소로도 열리지만 나가는 값은 숫자뿐입니다.

`FAIL_RATE` 로 장애를 주입하면 `status="500"` 으로 세어지므로, 에러율로 카나리를 중단시키는 것(GitOps `#24`)을 이 지표로 시험할 수 있습니다.

## 배포 명세 (`deploy.yaml`)
검토 서비스([review-service](https://github.com/Crystal-SBHackathon2026/review-service))가 PR 마다 읽어 검토하는 배포 요청 명세입니다.
형식은 [deploy-spec.md](https://github.com/Crystal-SBHackathon2026/review-service/blob/main/ai/docs/deploy-spec.md) 를 따르고, 지금 값은 GitOps `overlays/aws` 와 같습니다.

<!-- review-service #48 회귀 확인 (2026-10-09) -->
<!-- gitops #46 환경별 분석 적용 뒤 카나리 확인 (2026-10-10) -->
