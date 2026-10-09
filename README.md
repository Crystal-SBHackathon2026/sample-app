# sample-app

배포 시스템 데모용 샘플 웹앱입니다. 화면과 `/api/info`에 **어느 환경(로컬·AWS·GCP)이 응답했는지** 표시합니다.

| 경로 | 설명 |
| --- | --- |
| `/` | 응답한 환경과 버전 표시 |
| `/healthz` | 헬스체크 (Kubernetes probe, 배포 후 동작 확인) |
| `/api/info` | 환경 정보 JSON |

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
| `APP_VERSION` | 표시할 버전 |
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

## 배포 명세 (`deploy.yaml`)
검토 서비스([review-service](https://github.com/Crystal-SBHackathon2026/review-service))가 PR 마다 읽어 검토하는 배포 요청 명세입니다.
형식은 [deploy-spec.md](https://github.com/Crystal-SBHackathon2026/review-service/blob/main/ai/docs/deploy-spec.md) 를 따르고, 지금 값은 GitOps `overlays/aws` 와 같습니다.

<!-- 검토 파이프라인 회귀 시험 ① (2026-10-09) -->
<!-- 검토 파이프라인 확인: review-service#43 배포 후 (2026-10-09) -->
