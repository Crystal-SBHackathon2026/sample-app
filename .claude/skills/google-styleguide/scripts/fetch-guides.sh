#!/usr/bin/env bash
#
# Google 스타일 가이드 원문을 references/ 로 다시 내려받는다.
#
# 왜 사본을 두나: 에이전트가 네트워크 없이도 정본을 열 수 있어야 하기 때문이다.
# URL 만 적어 두면 "못 읽었으니 기억으로 쓴다"로 조용히 새고, 그게 정확히 이
# 정본을 도입해서 없애려던 상황이다.
#
# 사용: bash .claude/skills/google-styleguide/scripts/fetch-guides.sh

set -euo pipefail

readonly RAW_BASE='https://raw.githubusercontent.com/google/styleguide/gh-pages'
readonly DEST="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../references" && pwd)"

# 상류 경로 목록. 슬래시는 파일명에서 하이픈이 된다 (go/guide.md -> go-guide.md).
readonly PATHS=(
  'go/guide.md'
  'go/decisions.md'
  'go/best-practices.md'
  'docguide/style.md'
  'docguide/READMEs.md'
  'shellguide.md'
  'pyguide.md'
  'LICENSE'
)

main() {
  local upstream_path out_name failed=0
  for upstream_path in "${PATHS[@]}"; do
    out_name="${upstream_path//\//-}"
    if curl -fsSL "${RAW_BASE}/${upstream_path}" -o "${DEST}/${out_name}"; then
      printf 'OK   %s (%s bytes)\n' "${out_name}" "$(wc -c < "${DEST}/${out_name}")"
    else
      printf 'FAIL %s\n' "${upstream_path}" >&2
      failed=1
    fi
  done

  if (( failed )); then
    printf '\n일부 파일을 받지 못했다. 기존 사본은 그대로 두었다.\n' >&2
    return 1
  fi

  date -u '+%Y-%m-%dT%H:%M:%SZ' > "${DEST}/FETCHED"
  printf '\n갱신 완료. 날짜: %s\n' "$(cat "${DEST}/FETCHED")"
}

main "$@"
