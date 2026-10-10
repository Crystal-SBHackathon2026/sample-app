# 다중 환경 요청 예시 — 현재 데모에는 영향 없음

루트 `deploy.yaml`은 AWS 단일 명세 그대로다. 이 디렉터리의 파일은 예시이며 CI/웹훅이 자동으로 선택하지 않는다.

새 다중 환경 PR을 만들 때 `deployment-request.yaml`과 `deploy/`를 앱 루트로 복사한다.
`targets`에서 원하는 환경만 남긴다. 환경마다 region·cluster·path를 적고, 해당 `deploy/<env>.yaml`에 runtime·DB·network·storage·rollout 설정을 적는다.
명세 하나는 여전히 환경 하나다. 서버 등록 목록과 다른 클러스터 또는 명세와 다른 환경/region은 거절된다.

서비스 기능을 활성화하기 전 다중 환경 선택 파일을 루트에 넣으면 웹훅은 검토를 보류한다. AWS로 대체하지 않는다.
기존 AWS 데모에는 루트 선택 파일을 추가하지 않는다.

GCP 예시는 Blue/Green 자동 승격 지연 30초를 명세에 보존한다. 로컬 예시의 ingress는 현재 데모에 맞췄으므로 새 온프레미스에 사용할 때 실제 접근 정책을 확인한다.
이 예시로 새 인프라·DB·시크릿을 생성하지는 않는다.

CI의 `MULTI_TARGET_ENABLED` repository variable 기본값은 false다. false인 단일 명세는 기존 공통 base 이미지 갱신을 유지한다.
true인 단일 명세는 선택 환경 overlay의 이미지 버전만 갱신한다. 다중 환경 선택 파일이 있는 main 커밋의 GitOps 갱신은 검토 조정자가 담당한다.
