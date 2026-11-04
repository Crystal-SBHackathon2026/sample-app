#!/usr/bin/env bash
# PreToolUse(Bash): master/main 브랜치 위에서의 `git commit` 을 차단한다.
#
# 근거: 버전관리 정책 — "기본 브랜치 직접 커밋 금지.
#       기능마다 기본 브랜치에서 새 브랜치 → PR → squash merge."
#       (프로필 §7 vcs 참조.)
#
# `gh pr merge` 는 일부러 차단하지 않는다. 훅은 "사용자가 승인한 머지"와
# "모델이 독단으로 하는 머지"를 구분할 수 없기 때문이다.
#
# 알려진 한계: 명령 문자열에 git commit 이 들어간 비커밋 명령
# (예: echo "git commit") 도 차단된다. 탈출구로 우회한다.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

HOOK_ID="pre:bash:master-guard"
hook_disabled "$HOOK_ID" && exit 0

payload="$(cat)"
bind_session_state "$(printf '%s' "$payload" | json_get session_id)"   # 세션 루트(.root)를 찾으려고
bind_project_dir "$(printf '%s' "$payload" | json_get cwd)"
cmd="$(printf '%s' "$payload" | json_get tool_input.command)"
[ -z "$cmd" ] && exit 0

# default_branch_of <디렉토리> — 그 체크아웃이 기본 브랜치(master/main) 위이고 커밋이 하나라도
# 있으면 브랜치 이름을 내고 rc=0. 아니면 rc=1.
# symbolic-ref 는 unborn HEAD(커밋 0개)에서도 브랜치명을 준다. 실패(detached)면
# rev-parse 폴백 → "HEAD" 는 아래 case 에 안 걸려 통과된다(의도).
# 초기 커밋(HEAD 미존재)은 허용 — 신생 repo 의 첫 커밋은 기본 브랜치에 앉는 것이
# 관례고, base 커밋 없이는 PR 흐름 자체가 성립하지 않는다. (의도된 fail-open)
default_branch_of() {
  local b
  b="$(git -C "$1" symbolic-ref --short HEAD 2>/dev/null)" \
    || b="$(git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null)" \
    || return 1
  case "$b" in
    master|main) ;;
    *) return 1 ;;
  esac
  git -C "$1" rev-parse --verify -q HEAD >/dev/null 2>&1 || return 1
  printf '%s' "$b"
}

# command_targets <명령> — 명령이 겨누는 다른 디렉토리(`git -C <경로>` · `cd <경로>`)를 한 줄에
# 하나씩. 상대경로는 훅 입력의 cwd(없으면 프로젝트) 기준으로 붙인다.
#
# 왜: 워크트리 세션은 루트가 워크트리(기능 브랜치)라, 루트의 브랜치만 보면 `git -C <메인> commit`
# · `cd <메인> && git commit` 이 메인의 main 에 커밋하는데도 통과한다([cx] r1 #3).
# **완전한 셸 파싱이 아니다.** 잡는 형태: `-C 경로` · 명령 머리(`;` `&` `|` `(` 뒤 포함)의
# `cd 경로` — 경로는 인용 없음 · "겹따옴표" · '홑따옴표'. 못 잡는 형태(공시): 변수·`~`·`$(…)`
# 로 만든 경로, `pushd`, `--git-dir=`/`GIT_DIR=`, `-C경로`(붙여 쓰기), 줄바꿈으로 이어진 cd.
# 겨눈 이 저장소 디렉토리가 기본 브랜치면 그 명령의 커밋이 다른 디렉토리를 향해도 막는다 — 과탐 쪽이다.
command_targets() {
  local tok base="${HARNESS_CWD:-$PROJECT_DIR}"
  printf '%s' "$1" \
    | grep -oE "(-C|(^|[;&|(])[[:space:]]*cd)[[:space:]]+(\"[^\"]*\"|'[^']*'|[^[:space:];&|()]+)" \
    | while IFS= read -r tok; do
        tok="$(printf '%s' "$tok" | sed -E 's/^[;&|(]?[[:space:]]*(-C|cd)[[:space:]]+//')"
        case "$tok" in \"*\") tok="${tok#\"}"; tok="${tok%\"}" ;; \'*\') tok="${tok#\'}"; tok="${tok%\'}" ;; esac
        case "$tok" in /*) ;; *) tok="$base/$tok" ;; esac
        printf '%s\n' "$tok"
      done
}

# foreign_target <디렉토리> — 이 저장소 밖으로 **확인되면** rc=0: 상위 어디에도 `.git` 이 없거나
# (저장소 아님), 양쪽 --git-common-dir 이 조회됐는데 다르다(다른 저장소). 조회가 실패하면
# 판정 불가라 rc=1 — 호출자는 그 대상의 기본 브랜치 판정을 그대로 한다(막는 쪽).
# `.git` 을 직접 찾는 이유: git 조회의 실패는 "저장소 아님"과 "조회 실패"를 rc 로 가르지 못한다.
foreign_target() {
  local d common
  d="$(CDPATH='' cd -P -- "$1" 2>/dev/null && pwd -P)" || return 1
  while [ ! -e "$d/.git" ]; do
    [ "$d" = / ] && return 0
    d="$(dirname -- "$d")"
  done
  if [ -z "$ORIG_COMMON" ]; then
    ORIG_COMMON="$(git_dir_physical "$ORIG_ROOT" --git-common-dir)" || return 1
  fi
  common="$(git_dir_physical "$1" --git-common-dir)" || return 1
  [ "$common" != "$ORIG_COMMON" ]
}

# 판정 대상: 이 훅의 루트 + 입력 cwd(명령이 실제로 시작하는 곳) + 명령이 겨누는 디렉토리들.
# 하나라도 기본 브랜치면 그 브랜치를 쓴다. cwd 를 따로 보는 이유: 세션 루트는 고정이라
# (_common.sh) W 에 고정된 세션이 cwd=M(main) 에서 맨 `git commit` 을 하면 루트만 봐서는
# 놓친다([cx] r1).
# cwd·겨눈 디렉토리 중 **다른 저장소·저장소 아님으로 확인된 것**은 건너뛴다(foreign_target).
# 이 가드의 계약은 이 프로젝트 저장소의 기본 브랜치다. 다른 저장소(main 직접 커밋이 그쪽
# 규약일 수 있다)는 관여하지 않는다 — 그 저장소의 규약은 그쪽 몫이다.
branch="$(default_branch_of "$PROJECT_DIR")"
if [ -z "$branch" ]; then
  while IFS= read -r target; do
    [ -n "$target" ] && [ -d "$target" ] || continue
    foreign_target "$target" && continue
    branch="$(default_branch_of "$target")" && break
  done <<EOF
$HARNESS_CWD
$(command_targets "$cmd")
EOF
fi
[ -n "$branch" ] || exit 0

# `git commit ...` 과 `git -C dir commit ...` / `git -c k=v commit ...` 를 잡는다.
# 앞에 오는 문자가 영숫자/밑줄/하이픈이 아니어야 하므로 `&&`, `;`, 줄머리 뒤도 걸린다.
if ! printf '%s' "$cmd" | grep -Eq \
  -e '(^|[^[:alnum:]_-])git[[:space:]]+commit([[:space:]]|$)' \
  -e '(^|[^[:alnum:]_-])git[[:space:]]+-[^[:space:]]+([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+commit([[:space:]]|$)'
then
  exit 0
fi

{
  echo "[정책 차단] 기본 브랜치 직접 커밋 금지 — 버전관리 정책(프로필 §7)"
  echo
  echo "현재 브랜치: $branch"
  echo "차단된 명령: $(printf '%s' "$cmd" | cut -c1-120)"
  echo
  echo "해야 할 일:"
  echo "  git checkout -b feature/<이름>   # 기본 브랜치에서 새 브랜치"
  echo "  git commit ...                   # 브랜치 위에서 커밋"
  echo "  gh pr create ...                 # PR → squash merge (머지는 사용자 승인 후)"
  echo
  echo "정말 기본 브랜치에 직접 커밋해야 한다면:"
  echo "  HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=$HOOK_ID"
} >&2
exit 2
