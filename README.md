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
