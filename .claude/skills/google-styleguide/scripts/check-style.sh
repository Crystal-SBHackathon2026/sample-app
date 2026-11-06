#!/usr/bin/env bash
#
# Google 스타일 가이드의 **기계로 판정 가능한** 조항만 검사한다.
#
# 지금은 Go 포맷 하나다. Google Go 가이드 `Formatting` 절이 "모든 Go 소스는 gofmt 출력과
# 일치해야 한다"를 presubmit(머지 전 자동 검사)으로 강제하는데, 우리 쪽에서 그것에 대응하는
# 자리가 여기다. 사람이 눈으로 보는 조항(명명·줄 자르기)은 검수자의 몫이라 넣지 않는다.
#
# 언어를 발견해서 검사한다 — 어느 디렉토리에 무엇이 있는지 프로젝트마다 다르므로
# 경로를 박지 않는다. Go 모듈이 없으면 검사할 것이 없고 통과다.
#
# Stop 훅이 harness.env 의 HARNESS_STYLECHECK_CMD 를 통해 이 스크립트를 부른다 —
# 타입체크와 **다른 슬롯**이라 한쪽을 덮어써도 다른 쪽이 산다(ADR-0023). 키가 없으면
# Stop 훅이 이 경로를 직접 찾아 돌린다(기존 설치본에서 게이트가 조용히 꺼지지 않게).
# 새 언어가 편입되면(Java·TS) 여기에 해당 포매터 검사 함수를 더한다.
#
# 종료 코드: 0 통과 / 1 위반

set -uo pipefail

# 검사 대상 저장소. Stop 훅이 HARNESS_CHECK_ROOT 로 루트를 알려 주면 그 루트다 — 하네스가 메인
# 체크아웃에만 설치된 워크트리를 메인의 이 스크립트로 검사할 때, 스크립트 위치(메인)가 아니라
# 워크트리를 봐야 한다([cx] r1 #4). 없으면 스크립트가 든 저장소다(지금까지와 같다).
# 공시: Stop 은 이 값을 늘 덮어쓰지만, 셸에 같은 이름을 export 해 둔 채 직접 돌리면 그 루트를 본다.
REPO_ROOT="${HARNESS_CHECK_ROOT:-}"
[[ -n "${REPO_ROOT}" ]] || REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
readonly REPO_ROOT

# 탐색에서 제외할 디렉토리. 남의 코드(vendor·node_modules)를 우리 스타일로 판정하면
# 고칠 수 없는 위반이 영구히 게이트를 막는다.
readonly SKIP_DIRS='-name .git -o -name vendor -o -name node_modules -o -name .venv'

# check_go_format — 저장소 안의 모든 Go 모듈에서 gofmt 미준수 파일을 찾는다.
# 모듈이 없으면 검사할 것이 없으므로 통과다.
check_go_format() {
  local mod_file mod_dir unformatted found=0 failed=0

  # gofmt 이 없으면 검사할 수 없다. **조용히 통과시키지 않는다** — Stop 훅은 rc=0 을
  # "위반 없음"으로 기록하므로, 알리지 않으면 Go 저장소인데 스타일 게이트가 통째로
  # 사라진 것을 아무도 모른다(codex r1 HIGH). 차단하지는 않는다: 도구 부재는 위반이 아니고
  # 오탐 차단은 게이트를 벽돌로 만든다.
  if ! command -v gofmt >/dev/null 2>&1; then
    printf '[스타일] gofmt 이 없어 Go 포맷을 검사하지 못했다 — 스타일 게이트가 이 턴에는 비어 있다.\n' >&2
    return 0
  fi

  # while-read 를 쓴다: 파이프 서브셸에서 exit 로 신호하면 rc 가 밖으로 안 나오고,
  # 경로에 공백이 있으면 for 루프의 단어 분리가 깨진다.
  while IFS= read -r mod_file; do
    found=1
    mod_dir="$(dirname -- "${mod_file}")"
    unformatted="$(cd "${mod_dir}" && gofmt -l . 2>/dev/null)"
    [[ -z "${unformatted}" ]] && continue

    if (( ! failed )); then
      printf '[스타일] Google Go 가이드 Formatting 위반 — gofmt 출력과 다른 파일:\n' >&2
      failed=1
    fi
    printf '%s (모듈: %s)\n' "${unformatted}" "${mod_dir}" >&2
  done < <(find "${REPO_ROOT}" \( ${SKIP_DIRS} \) -prune -o -name go.mod -print 2>/dev/null)

  if (( failed )); then
    printf '고치려면 각 모듈에서: gofmt -w .\n' >&2
    return 1
  fi

  # gofmt 이 없어서 건너뛴 경우와 구분하려고 발견 여부를 남긴다(디버깅용, 조용히).
  (( found )) || return 0
  return 0
}

main() {
  local failed=0
  check_go_format || failed=1
  return "${failed}"
}

main "$@"
