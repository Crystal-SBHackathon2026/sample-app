#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): 편집된 파일이 완료 게이트 대상이면 플래그를 세운다.
# PostToolUse(Bash) · PostToolUseFailure(Bash): Bash 가 바꾼 파일을 같은 판정으로 스윕한다.
#
# 왜 PostToolUseFailure(Bash) 에도 거는가 (2026-10-08 실측): Claude Code 가 도구 실패로
# 처리한 Bash(예: `false`)에는 PostToolUse 가 아니라 PostToolUseFailure 가 발화한다(종료
# 코드가 0 이 아니면 전부 그렇다고 단정하지 않는다 — 결과 분류는 Claude Code 몫이다).
# PostToolUse 에만 걸려 있을 때는 mark-bash-window 가 찍은 창이 그런 호출마다 소비되지
# 않고 남았다(`false` 한 번에 1개, 실세션 약 110개). 남은 옛 창이 "가장 오래된 창"이 되어
# 리뷰·설명이 끝난 파일이 Bash 마다 다시 플래그에 오르고, record_flag 의 touch 로 플래그
# mtime 이 계속 새로워져 리뷰 산출물에 의한 자동 해제가 영영 안 됐다. 실패 페이로드에는
# tool_response 가 없고 error 가 있지만 이 훅은 둘 다 읽지 않으므로 이벤트 이름으로
# 분기하지 않는다(같은 판정).
# 남는 한계: 권한 거부·PreToolUse 차단으로 시작조차 안 한 호출과 실행 중 사용자 취소
# (취소는 PostToolUseFailure 를 발화하지 않는다 — r2 리뷰 인용, 미대조)는 어느 Post
# 이벤트도 발화하지 않아 창이 남는다. 스윕이 짝을 찾지 않고 가장 오래된 창을 쓰므로, 정상
# Pre/Post 한 쌍은 창 하나를 만들고 옛 창 하나를 소비할 뿐 **잔류 창 수는 줄지 않는다**.
# 그래서 잔류 창이 있는 동안 **모든 Bash 가 앞선 호출의 창 기준으로 스윕해** 리뷰가 끝난
# 직전 변경을 다시 플래그한다(지연 오탐이 계속된다 — 몇 번 뒤 끝나지 않는다). 잔류 창을
# 줄이는 것은 60분 만료 정리뿐이고, 그것도 타이머가 아니라 다음 PreToolUse(Bash) 때 도는
# find 다. 호출이 잦으면 남는 창이 계속 새것으로 바뀌어 만료에 안 걸릴 수 있다. 상세·후속
# (설계부터 별도)은 ADR-0024 후속 이력.
#
# 이 플래그는 completion-auditor 가 검증을 통과시킨 뒤에만 지워진다.
# Stop 훅이 플래그를 보고 턴 종료를 막는다 → 감사자 호출이 강제된다.
# 커밋 여부와 무관하게 동작하므로 "커밋해서 트리가 clean 해졌으니 통과" 같은 구멍이 없다.
#
# 검사 범위:
#   프로젝트 안       — _workspace/·.claude/·순수 *.md|*.markdown(대소문자 무관) 를 뺀 전부
#   밖 + 하네스 정본  — 저장소(루트에 template/.claude/) **전체**를 프로젝트와 같은 규칙으로
#   밖 + 그 외        — .claude/ 앵커에 걸린 하네스 파일만 (git 저장소일 필요 없음)
#   설계·계획 산출물  — 위치·git 무관하게 _workspace/[0-9][0-9]_design*.md·[0-9][0-9]_plan*.md 는
#                       듀얼리뷰+지식+**머리 표명 2종**(ADR-0013·0015 — 머리 두 줄
#                       형식(회수·레퍼런스 조사)을 Stop 이 검사)
#   결정 문서        — docs/decisions/*.md 는 문서 제외의 예외로 지식만
#   추가 관할 폴더    — 슬롯(ADR-0026, 옵트인) 안·루트 밖: 최상위가 슬롯 안인 저장소를 그 기준으로
#                       (⑤′), 설계 모양은 _workspace_*/ 아래도. 듀얼리뷰 판정은 리뷰 자리를 기록
#
# 왜 이렇게 넓나 (2026-08-04 실사고): 하네스 자신을 고치는 작업은 **늘** 별도 클론에서
# 일어나는데 훅이 프로젝트 밖을 통째로 스킵해, 게이트가 프로젝트는 지키면서 정작 하네스
# 자체 개발만 못 지켰다.
# 왜 위치가 아니라 경로 모양인가: 예전엔 홈 디렉터리를 통째로 예외 처리했는데, 그 규칙이
# 남의 닷파일 저장소를 오탐하면서(vimrc) 정작 홈에 설치된 하네스 파일은 놓쳤다. 위치는
# 게이트 대상 여부와 상관이 없다 — 하네스 동작을 정의하는 파일인지가 상관있다.
# 홈 디렉터리 예외는 삭제됐다. 되살리지 마라 (회귀 테스트가 정적으로 막는다).
#
# 기록값: 프로젝트(= 세션 루트, _common.sh) 안은 상대경로, 밖은 **절대경로**. 밖 편집을
#         상대경로로 적으면 프로젝트 쪽 동명 파일과 구분되지 않는다. 같은 저장소의 다른
#         체크아웃(메인·형제 워크트리)은 그 체크아웃 기준으로 분류하고 절대경로로 적는다.
#
# PostToolUse 는 절대 차단하지 않는다(도구는 이미 실행됨). 항상 exit 0.
# 차단할 수 없으므로, 기록에 **실패**했거나 경로 때문에 기록을 **포기**했을 때는
# stdout 의 systemMessage 로 알린다 — 조용히 게이트가 사라지는 것보다 낫다.
#
# 이 판정 계약의 기계 정본은 tests/mark-needs-audit.cases.sh 이고
# tests/mark-needs-audit.test.sh 가 그것을 돌린다.
# 셸 이식성: macOS 기본 bash 는 3.2 다. ${var,,}·mapfile·연관배열 금지.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

HOOK_ID="post:edit:needs-audit"
hook_disabled "$HOOK_ID" && exit 0

# 메시지 상수. " 와 \ 와 제어문자를 쓰지 않는다 — 그래서 이스케이프 로직이 필요 없다.
# 경로를 넣지 않는 것도 같은 이유다: 기록 실패 상황에서 사용자에게 필요한 정보는
# "게이트가 안 섰다"는 사실이고, 경로를 끼우는 순간 이스케이프 기계장치가 딸려온다.
MSG_WRITE_FAIL="완료 게이트 플래그를 기록하지 못했다(.claude 쓰기 실패). 게이트가 서지 않았으니 완료 판정 전에 수동으로 확인하라."
MSG_NEWLINE="편집 경로에 개행이 있어 게이트 플래그를 기록하지 않았다. 줄 단위 플래그 파일이 오염되기 때문이다. 수동으로 확인하라."
MSG_GIT_UNAVAILABLE="git 이 저장소 정보를 돌려주지 못해(소유권 거부·권한·손상) 하네스 정본 여부를 판정하지 못했다. 앵커 밖 파일에는 게이트가 서지 않았으니 수동으로 확인하라."
MSG_SWEEP_TRUNCATED="이 명령이 바꾼 파일이 너무 많아 일부만 게이트에 기록했다. 나머지에는 게이트가 서지 않았으니 수동으로 확인하라."
MSG_SWEEP_PARTIAL="이 명령이 바꾼 파일 중 일부는 게이트에 기록하지 못했다(경로에 개행이 있거나 기록에 실패). 그 파일들은 수동으로 확인하라."
# 슬롯이 켜졌을 때만: 명령문 경로가 상한을 넘었거나 홈 경로 토큰을 읽지 못해 뿌리를 다 못 훑음.
MSG_SWEEP_ROOT_CAP="이 명령이 가리킨 경로가 많거나 그 경로를 읽지 못해 일부 저장소·작업 공간만 훑었을 수 있다. 나머지에서 바꾼 파일에는 게이트가 서지 않았을 수 있으니 수동으로 확인하라."
# 슬롯이 켜졌을 때만: 스윕이 시간 예산에 닿아 끊김(Bash 훅 30 s 상한 전에 스스로 멈춘다).
MSG_SWEEP_TIME_CUT="이 명령의 스윕이 시간 예산을 다 써서 바꾼 파일의 일부 또는 전부를 게이트에 기록하지 못했다. 기록하지 못한 파일에는 게이트가 서지 않았으니 수동으로 확인하라."
# 추가 관할 폴더 슬롯(ADR-0026)을 쓸 수 없을 때의 알림 머리. 사유 문구는 _common.sh 의
# extra_problem_text 가 뒤에 붙는다 — 모듈이 없어도 나가야 하기 때문이다.
MSG_EXTRA_HEAD="추가 관할 폴더 슬롯(harness.env 의 HARNESS_EXTRA_GATE_DIRS)을 쓸 수 없다 — 고칠 때까지 슬롯 폴더 안 저장소 편집에 게이트가 서지 않고 리뷰 자리도 기록되지 않는다. 사유: "
# 리뷰 자리 기록(슬롯 수명 계약 ①·③) 실패 — 회복 가능(쓰기 실패 · 기록 파일이 일반 파일 아님)과
# 영구(경로에 US·LF · 줄 1023바이트 초과). 영구면 그 값은 다시 저장 · 이름 · 위치 바꾸기로 이번
# 막음이 풀리지 않는다(옛 값이 플래그에 남는다) — 그것을 출구로 안내하지 않는다. 슬롯 저장소의
# git 판독 실패로 자리를 정하지 못한 경우(MSG_RECORD_GIT)는 git 이 회복된 뒤 다시 저장하면 된다 —
# 단 현재 기록 줄만 1023바이트를 넘는 값은 그때 영구 알림이 나간다(git 이 실패한 때는 자리를 몰라
# 줄 길이를 알 수 없어, 문구가 그 경우를 함께 적는다). 셋 다 RECORD_MSG 로 나가 Bash 스윕의 집계
# 문구로 접히지 않는다. 갱신 표시부터 기록할 수 없는 값(US·LF · 갱신 표시 줄 1023바이트 초과)이
# git 판독도 실패하면 영구 문구만 낸다 — git 을 고쳐 다시 저장해도 그 값은 기록되지 않는다.
MSG_RECORD_FAIL="리뷰 자리 기록에 실패했다(세션 폴더 쓰기 · 기록 파일 종류 확인). 그 파일을 다시 저장하라 — 그 전까지 그 값은 턴 종료에서 막히거나 옛 소속 자리 리뷰로 풀릴 수 있다."
MSG_RECORD_GIT="git 이 저장소 정보를 돌려주지 못해(소유권 거부·권한·손상) 그 값의 리뷰 자리를 정하지 못했다 — 게이트는 섰고 그 값은 턴 종료에서 막힌다. git 이 그 저장소를 다시 읽을 수 있게 된 뒤 그 파일을 다시 저장하면 기록된다(소유권·권한·손상을 어떻게 고칠지는 사용자에게 알려 판단을 받아라). 단 그 값의 기록 줄(값과 리뷰 자리 경로들)이 1023바이트를 넘으면 그때 기록할 수 없다는 영구 알림이 나가고, 그 막음은 다시 저장 · 이름 · 위치 바꾸기로 풀리지 않는다."
MSG_RECORD_PERMANENT="경로에 기록할 수 없는 제어문자가 있거나 기록 줄이 1023바이트를 넘어 리뷰 자리를 기록하지 못했다(영구) — 그 값이 슬롯 안 항목이면 턴 종료에서 막히고, 다시 저장해도 · 파일 이름이나 저장소 위치를 바꿔도 이번 막음은 풀리지 않는다. 사용자에게 알려 판단을 받아라(다음부터 막히지 않게 이름이나 위치를 바꿀지는 사용자가 정한다)."

# --- 계약 함수 ------------------------------------------------------------

# emit_message <메시지> — {"systemMessage":"..."} 를 stdout 에 한 줄로.
# JSON 을 만드는 **유일 지점**이다. 여기 말고 다른 곳에서 stdout 에 쓰면 안 된다.
emit_message() {
  printf '{"systemMessage":"%s"}\n' "$1"
}

# --- 추가 관할 폴더 슬롯 알림 · 단일 출구 ----------------------------------
#
# stdout 은 호출마다 JSON 한 줄이 계약이다(PostToolUse). 판정·스윕·슬롯 알림이 각자
# 내면 줄이 여럿이 되므로 진입 뒤(훅 비활성 확인 뒤)의 모든 종료 경로가 finish_hook 하나를
# 지난다. 키가 없으면(ABSENT) 알림이 없어 출력은 예전 바이트 그대로다.
EXTRA_ON=0       # 슬롯이 켜졌는가
NOTICE_CODE=""   # 슬롯을 쓸 수 없는 사유 코드(빈 값이면 알릴 것 없음)
SWEEP_MSG=""     # Bash 스윕의 최종 메시지(sweep_bash_writes 가 정한다)
RECORD_MSG=""    # 리뷰 자리 기록 실패 문구(슬롯이 켜졌을 때만 생긴다 — 판정 알림과 따로)

#######################################
# 슬롯 키를 읽어 EXTRA_ON·NOTICE_CODE 를 정한다. 표식은 쓰지 않는다 — 출력이 성공한
# 뒤에 finish_hook 이 쓴다. 부재이거나 정상이면 옛 표식을 지워, 다시 망가지면 다시
# 알리게 한다. 부재일 때 하는 일은 판독 1회와 셸 내장 검사뿐이다(모듈 미적재).
# Globals:
#   EXTRA_NOTICE_FILE, EXTRA_GATE_RAW, EXTRA_GATE_PROBLEM (읽음) ·
#   EXTRA_ON, NOTICE_CODE (씀)
# Arguments:
#   없음
# Returns:
#   0
#######################################
extra_gate_setup() {
  local state module
  EXTRA_ON=0
  NOTICE_CODE=""
  extra_gate_key_state
  state=$?
  if [[ "$state" -eq 3 ]]; then
    [[ -e "$EXTRA_NOTICE_FILE" ]] && rm -f "$EXTRA_NOTICE_FILE" 2>/dev/null
    return 0
  fi
  if [[ "$state" -ne 0 ]]; then
    NOTICE_CODE="untrusted"
    return 0
  fi
  module="$(dirname "${BASH_SOURCE[0]}")/_extra_gate_dirs.sh"
  if ! { . "$module"; } 2>/dev/null; then
    NOTICE_CODE="module"
  elif ! validate_extra_gate_dir "$EXTRA_GATE_RAW" 2>/dev/null; then
    NOTICE_CODE="${EXTRA_GATE_PROBLEM:-module}"
  else
    EXTRA_ON=1
    [[ -e "$EXTRA_NOTICE_FILE" ]] && rm -f "$EXTRA_NOTICE_FILE" 2>/dev/null
  fi
  return 0
}

#######################################
# 진입 뒤의 유일한 출구(훅 비활성이면 그 전에 끝난다). 분기의 최종 메시지 하나 뒤에
# 리뷰 자리 기록 실패 문구를, 앞에 슬롯 알림(그 사유를 이 세션에 아직 알리지 않았으면)을
# 붙여 JSON 한 줄로 내고, 출력이 성공했을 때만 표식에 사유를 적는다 — stdout 이 닫혀 못
# 낸 알림은 다음 호출이 다시 낸다.
# 기록 실패 문구는 슬롯이 켜졌을 때만 생기므로 키가 없으면 출력은 예전 바이트 그대로다.
# Globals:
#   NOTICE_CODE, EXTRA_NOTICE_FILE, MSG_EXTRA_HEAD, RECORD_MSG (읽음)
# Arguments:
#   $1 — 분기의 최종 메시지(Edit = 판정 알림, Bash = 스윕 집계, 빈 명령 = 빈 값)
# Outputs:
#   알릴 것이 있으면 {"systemMessage":"…"} 한 줄
# Returns:
#   돌아오지 않는다(exit 0 — PostToolUse 는 차단하지 않는다)
#######################################
finish_hook() {
  local msg="${1:-}" notice="" seen=""
  if [[ -n "$NOTICE_CODE" ]]; then
    # 표식은 일반 파일일 때만 읽는다 — FIFO 면 시간 제한 없이 기다린다. 아니면 매번 알린다.
    [[ -f "$EXTRA_NOTICE_FILE" ]] \
      && { IFS= read -r seen < "$EXTRA_NOTICE_FILE"; } 2>/dev/null
    [[ "$seen" == "$NOTICE_CODE" ]] \
      || notice="$MSG_EXTRA_HEAD$(extra_problem_text "$NOTICE_CODE")."
  fi
  [[ -n "$RECORD_MSG" ]] && msg="${msg:+$msg }$RECORD_MSG"
  [[ -n "$notice" ]] && msg="$notice${msg:+ $msg}"
  [[ -n "$msg" ]] || exit 0
  emit_message "$msg" 2>/dev/null || exit 0
  # 쓰기도 일반 파일이거나 아직 없을 때만 — FIFO 를 쓰기로 열면 읽는 쪽을 기다린다.
  if [[ -n "$notice" ]] && { [[ -f "$EXTRA_NOTICE_FILE" ]] \
      || [[ ! -e "$EXTRA_NOTICE_FILE" && ! -L "$EXTRA_NOTICE_FILE" ]]; }; then
    # 쓰기 실패(EFBIG 등) 때 bash 3.2 printf 가 버퍼에 남긴 줄이 exit 때 stdout 으로 나가
    # JSON 한 줄을 깨지 않게 버퍼를 /dev/null 로 비운다(append_review_record 와 같다).
    { printf '%s\n' "$NOTICE_CODE" > "$EXTRA_NOTICE_FILE"; } 2>/dev/null \
      || echo >/dev/null 2>&1
  fi
  exit 0
}

# physical_dir <디렉토리> — 심링크·`..`·`.` 를 푼 물리 절대경로를 stdout 에.
# 실패하면 **원본을 그대로 내고** rc=1. 호출자는 스킵하지 않는다 — 정규화에 실패했다고
# 게이트를 지우면 조용한 위음성이 되므로, 덜 정확한 경로로라도 판정을 잇는 쪽을 택한다.
#
# **cd 는 반드시 -P 여야 한다** — pwd -P 만으로는 부족하다. 논리 cd(기본값)는 `심링크/..` 를
# 심링크를 따라가기 **전에** 문자로 상쇄하므로 커널이 실제로 여는 곳과 다른 답을 낸다
# (실측: `cd -- /var/..` → `/`, `cd -P -- /var/..` → `/private`). 그 차이만큼 프로젝트
# **밖** 파일이 프로젝트 **안** 상대경로로 기록돼, 게이트는 서는데 감사자가 엉뚱한 파일을
# 본다(케이스 67). 반대 방향으로는 밖 하네스 파일의 게이트가 통째로 사라진다(케이스 68).
# physical_path 는 형제 검사기였던 check-rule-copies(PR #13 검증, 2026-08-17 단일 정본화로 폐지)와 같은 방식이다.
physical_dir() {
  local out
  out="$(CDPATH='' cd -P -- "$1" 2>/dev/null && pwd -P)"
  if [ -z "$out" ]; then
    printf '%s\n' "$1"
    return 1
  fi
  printf '%s\n' "$out"
}

# physical_path <파일경로> — 편집 경로를 물리화한다. 실패하면 **원본 경로를 그대로 내고** rc=1.
#
# 마지막 성분이 **이름이면 보존**한다 — 파일 자신이 심링크여도 편집 대상의 이름으로
# 기록해야 하고, 애초에 파일에는 cd 할 수 없다. 파일이 아직 없을 수도 있다(케이스 51).
#
# **단 `.`·`..` 는 이름이 아니라 디렉토리 이동이라 반드시 푼다.** 보존할 이름이 없으므로
# 위 예외의 근거가 성립하지 않는다. 안 풀면 dirname 만 물리화된 `…/src/..` 가 그대로 나와
# 프로젝트 접두사에 문자열상 걸리고, 플래그에 디렉토리 표기가 박힌다(케이스 69·70).
# 형제 검사기가 PR #13 에서 같은 이름의 같은 버그를 이 방식으로 고쳤다 — 접근을 맞춘다.
physical_path() {
  local dir base
  base="$(basename -- "$1")"
  # cd 는 반드시 명령 치환 안에서 — 함수 본문에서 그냥 cd 하면 호출부의 cwd 가 바뀐다.
  case "$base" in
    . | ..) physical_dir "$1"; return ;;
  esac
  dir="$(physical_dir "$(dirname -- "$1")")" || { printf '%s\n' "$1"; return 1; }
  # pwd -P 가 "/" 를 낼 때만 "//base" 가 된다 (루트 바로 아래 경로).
  if [ "$dir" = '/' ]; then dir=''; fi
  printf '%s/%s\n' "$dir" "$base"
}

# project_rel <절대경로> — $proj 아래면 프로젝트 기준 상대경로를 stdout·rc=0, 아니면 rc=1.
# 접두사에 **슬래시를 반드시 포함**한다. 빠뜨리면 형제 디렉토리(<proj>-backup/…)를
# 프로젝트 안으로 오인한다. "$proj" 를 인용하는 것은 경로 안의 글롭 문자 때문이다.
# 슬롯이 켜졌으면 표기만 다른 루트 경로도 같은 폴더 기준(-ef)으로 루트 안이다 — ⑤′ 의
# 루트 제외(is_slot_entry)와 기준이 갈리면 그 편집을 어느 분기도 맡지 않는다. 키가
# 없으면 문자열 비교 그대로다(키가 없을 때의 판정을 바꾸지 않는다).
project_rel() {
  case "$1" in
    "$proj"/*) printf '%s\n' "${1#"$proj"/}"; return 0 ;;
  esac
  [ "$EXTRA_ON" -eq 1 ] && find_same_dir_prefix "$1" "$proj" \
    && [ "$SAME_DIR_PREFIX" != "$1" ] || return 1
  printf '%s\n' "${1#"$SAME_DIR_PREFIX"/}"
}

# git_toplevel <절대경로> — 그 파일이 속한 git 저장소 루트를 물리 경로로. 없으면 rc=1.
# GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE 을 소거한다: 훅이 git 훅 안에서 돌면 이 변수들이
# 엉뚱한 저장소를 가리켜 귀속이 통째로 바뀐다.
# 경로에 /.git/ 가 있으면 그 앞을 기준으로 삼는다: git 은 .git 안에서 --show-toplevel 에
# 실패하므로(실측 rc=128), 그대로 물으면 .git/hooks/* 편집이 판정 불가로 새어나간다.
git_toplevel() {
  local dir top
  case "$1" in
    */.git/*) dir="${1%%/.git/*}" ;;
    */.git)   dir="${1%/.git}" ;;
    *)        dir="$(dirname -- "$1")" ;;
  esac
  top="$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
         git -C "$dir" rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$top" ] || return 1
  physical_dir "$top"
}

# has_git_ancestor <절대경로> — 조상 디렉토리에 .git 이 있는가. git 을 쓰지 않는다.
# git_toplevel 이 빈 값을 돌려준 이유가 "저장소가 아님"인지 "git 이 거부함"인지를 가르는
# 데 쓴다. rev-parse 는 둘 다 rc=128 로 돌려주므로 stderr 내용으로 가르는 것은 취약하다.
has_git_ancestor() {
  local d
  d="$(dirname -- "$1")"
  while [ "$d" != '/' ] && [ "$d" != '.' ]; do
    [ -e "$d/.git" ] && return 0
    d="$(dirname -- "$d")"
  done
  return 1
}

# is_harness_canonical <저장소루트> — 하네스 정본 저장소인가.
# 마커는 이 한 조건뿐이다. 조건을 더 얹으면 재배치 포크에서 위음성이 넓어지는데,
# 위음성은 조용하고 오탐은 탈출구(ECC_DISABLED_HOOKS)가 있다 — 그래서 단순한 쪽을 택했다.
is_harness_canonical() {
  [ -d "$1/template/.claude" ]
}

# harness_anchor <선행 슬래시가 있는 경로> — 하네스 동작을 정의하는 자리인가.
# 앵커 목록을 정의하는 **유일 지점**이다.
harness_anchor() {
  case "$1" in
    */.claude/agents/*|*/.claude/skills/*|*/.claude/hooks/*|*/.claude/harness/*|*/.claude/settings.json)
      return 0 ;;
  esac
  return 1
}

# classify <기준 상대경로> <기준 디렉토리> — gate · knowledge · skip 을 stdout 에.
# 프로젝트 안(4a)과 밖-하네스정본(4b)이 **같은 규칙**을 쓰도록 공유한다.
#
# 순서가 계약이다:
#   1) .claude/*·_workspace/* 제외가 앵커보다 **먼저**. 그래야 하네스 정본 저장소가
#      자기 자신에 설치해 둔 소비 사본(.claude/hooks/*)이 빠지고 정본(template/.claude/*)만
#      발화한다. 설치본은 정본을 고쳐 sync 하는 게 규약이라 제자리 편집은 일시적이다.
#   2) 앵커가 *.md 제외보다 먼저. 에이전트·스킬·원칙 정의는 전부 .md 인데 일괄 제외하면
#      하네스 저장소에서 가장 흔한 변경에 플래그가 하나도 안 선다.
#   3) global-agents/*.md 는 **정본 스코프에서만** 예외의 예외를 연다. install/sync 가
#      배포하는 전역 에이전트 정본이기 때문이며, 남의 프로젝트로 새면 오탐이 된다.
classify() {
  local rel="$1" base="$2" lower
  case "$rel" in
    _workspace/*|.claude/*) printf 'skip\n'; return 0 ;;
  esac
  if harness_anchor "/$rel"; then
    printf 'gate\n'; return 0
  fi
  case "$rel" in
    global-agents/*.md)
      if is_harness_canonical "$base"; then printf 'gate\n'; return 0; fi ;;
  esac
  # 확장자 판정은 소문자화해서 본다 — README.MD 가 코드로 취급되면 안 된다.
  lower="$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')"
  # 결정 문서는 문서 제외의 **예외**다. 하네스가 스스로 "결정은 여기 이 이름으로 쓴다"고
  # 규정한 경로(결정 기록 절)라 **하네스가 아는 산출물**이고, 그 자리가 편집됐다는 것은
  # 곧 결정이 나왔다는 뜻이다. 코드가 아니므로 게이트 4종은 과하다 — 지식 게이트만 세운다.
  #
  # 공시된 한계: 결정 문서를 이 경로 **밖**에 두면 게이트가 서지 않는다. 하네스가 아는
  # 경로만 알 수 있기 때문이고, 프로젝트마다 다른 위치를 알아내려면 다시 상위 층 구현을
  # 알아야 한다. 이 공백은 회수 정책 ADR 로 넘긴다.
  case "$lower" in
    docs/decisions/*.md|docs/decisions/*.markdown) printf 'knowledge\n'; return 0 ;;
  esac
  case "$lower" in
    *.md|*.markdown) printf 'skip\n'; return 0 ;;
  esac
  printf 'gate\n'
}

# record_flag <플래그파일> <값> — 이미 있으면 그냥 두고, 없으면 한 줄 덧붙인다. 실패하면 rc=1.
# grep 의 -- 는 필수다: 값이 - 로 시작하면(예: 파일명 --version) grep 이 그것을 옵션으로
# 해석해 rc=0(=이미 있음)을 돌려주고, BSD grep 은 -q 아래서도 버전 문자열을 stdout 에 뱉는다.
# append 를 중괄호로 감싸는 것도 필수다: 리다이렉트 **열기** 실패는 셸이 보고하는데,
# printf 뒤에 붙인 2>/dev/null 은 그 시점에 아직 적용되지 않아 stderr 가 샌다(실측).
record_flag() {
  mkdir -p "$(dirname "$1")" 2>/dev/null
  if grep -qxF -- "$2" "$1" 2>/dev/null; then
    # [cx] 같은 경로 재편집도 플래그 mtime 을 갱신해야 한다 — 안 하면 이전 리뷰
    # 산출물이 플래그보다 "새로워서" 미리뷰 편집이 자동 해제된다(stale review 우회).
    touch "$1" 2>/dev/null
    return 0
  fi
  { printf '%s\n' "$2" >> "$1"; } 2>/dev/null || return 1
  return 0
}

# --- Bash 스윕 -------------------------------------------------------------
#
# **왜 필요한가 (2026-09-05 실사고):** 이 훅은 Edit|Write|MultiEdit 에만 걸려 있어서
# `cat > 파일`·`sed -i`·`python3` 로 쓴 파일은 게이트를 통째로 지나쳤다. 하네스 정본
# (template/.claude/*)을 Bash 로 고친 세션 전체가 무게이트로 끝났다 — 게이트가 있다고
# 믿는 쪽이 없는 것보다 나쁘다.
#
# **명령을 파싱하지 않는다.** 무엇을 썼는지 명령줄에서 알아내려는 시도는 히어독·리다이렉트·
# 스크립트 호출마다 새는 구멍을 만든다. 대신 **결과를 본다**: PreToolUse 가 찍어 둔 시각
# 표식보다 새로 바뀐 파일을 찾는다. 명령이 어떻게 썼든 파일 mtime 은 거짓말하지 않는다.
#
# **판정은 Edit 경로와 같은 함수(judge_file)에 맡긴다.** classify 의 사본을 만들지 않으려는
# 것이다 — 사본을 두는 순간 두 판정이 어긋나는 날이 온다(이 저장소가 반복해서 배운 것).
# 예전엔 파일마다 이 스크립트를 재호출했는데, 150파일에 훅 상한(15s)을 넘었고([cc] r1 #5),
# 그것을 줄이려고 둔 환경 변수 진입 모드는 상속 환경 하나로 기록을 통째로 건너뛰는 무음
# 스위치가 됐다([cc·cx] r2). 같은 프로세스 안에서 함수를 부르면 둘 다 없다 — 이 훅의 진입은
# 언제나 실제 JSON 입력 하나다.
WINDOW_DIR="$SESSION_STATE_DIR/.bash-windows"   # 입력을 읽은 뒤 세션 폴더로 다시 잡는다
BASH_WINDOW=""         # 이번 스윕이 쓸 창. sweep_bash_writes 가 고른다.
SWEEP_MAX=200          # 병적인 명령(대량 생성)에서 판정이 폭주하지 않게
SWEEP_MAX_ROOTS=3      # 프로젝트 밖 뿌리 탐색의 상한
# 슬롯이 켜졌을 때 스윕이 쓰는 시간(초, 훅 시작부터 — SECONDS). Bash 훅 상한(30 s)에
# 걸려 취소되면 알림도 창 소비도 없이 다음 Bash 마다 같은 창을 다시 돈다 — 그 전에 끊고
# 절단을 알린다. 키가 없으면 쓰지 않는다(키가 없을 때의 동작은 예전 그대로).
SWEEP_BUDGET=20
SWEEP_END='.'          # 순회 입력의 끝 표지(find 경로·status 레코드가 될 수 없다)
SWEEP_KEEP_WINDOW=0    # 순회 입력을 다 읽지 못했다 — 창을 남겨 다음 Bash 가 다시 훑는다
SWEEP_TIME_CUT=0       # 시간 예산에 닿아 끊었다(절단 문구를 가른다)

# find 의 prune 목록. **성능을 위한 것만 남긴다.**
# 예전엔 dist·build·target·vendor 도 잘라냈는데, 그것들이 **git 에 추적 중**이면
# Edit 경로의 classify 는 게이트 대상으로 보는데 스윕만 통째로 건너뛰었다 —
# "판정은 재호출로 단일화한다"는 이 스윕의 전제와 어긋난다(codex r1 HIGH).
# 무엇이 산출물인지는 아래 git check-ignore 가 판정한다. 여기서 다시 정하지 않는다.
SWEEP_PRUNE='-name .git -o -name node_modules -o -name .venv -o -name __pycache__'

# sweep_find <뿌리> [ws] — 표식 이후 바뀐 파일을 **NUL 구분**으로.
# 개행이 든 파일명을 줄 단위로 읽으면 **두 개의 가짜 경로**로 쪼개져, 엉뚱한 경로가
# 플래그에 박히고 정작 그 파일은 무게이트가 된다([cc] r1 지적). find 의 -print0 과
# read -d '' 조합이 그 부류를 통째로 없앤다.
# ws 면 그 폴더 바로 아래만 본다(작업 공간 뿌리) — 설계물은 부모가 그 작업 공간인
# 파일이다. 더 깊은 _workspace* 는 다른 작업 공간(다른 트랙일 수 있다)이라, 가리켜졌을
# 때 그 뿌리로 따로 훑는다(다른 트랙의 쓰기를 이 세션 의무로 잡지 않게).
sweep_find() {
  if [ "${2:-}" = ws ]; then
    find "$1" -maxdepth 1 -type f -newer "$BASH_WINDOW" -print0 2>/dev/null
    return
  fi
  # SWEEP_PRUNE 은 find 의 인자 목록이라 의도적으로 인용하지 않는다.
  # shellcheck disable=SC2086
  find "$1" \( $SWEEP_PRUNE \) -prune -o -type f -newer "$BASH_WINDOW" -print0 2>/dev/null
}

# existing_ancestor <절대경로> — 그 경로가 있으면 그대로, 없으면 남아 있는 가장 가까운 조상을
# EXISTING 에 담는다(서브셸 없이). 다 없으면 빈 값. 지워진 경로(`rm`·`rm -rf <폴더>`)로 git 을
# 부르면 조회가 실패해 그 체크아웃의 의무가 무기록이 된다([cx] r1 · 확인 패스 1).
existing_ancestor() {
  EXISTING="$1"
  while [ -n "$EXISTING" ] && [ ! -e "$EXISTING" ]; do EXISTING="${EXISTING%/*}"; done
}
EXISTING=""

# abs_path_tokens <명령문> — 명령문의 절대경로 토큰(탐색 힌트 — 명령 해석이 아니다).
abs_path_tokens() {
  printf '%s' "$1" | grep -o '/[A-Za-z0-9_./~@+-]\{2,\}' 2>/dev/null | sort -u
}

# --- 뿌리 수집의 상태 · 캐시 ---------------------------------------------------
SWEEP_BASE=""          # 저장소 뿌리(LF 줄 목록 — 세션 루트가 늘 첫 줄)
SWEEP_ROOTS_CUT=0      # 뿌리 수집 중에 시간 예산이 끝났다(스윕 전체를 끊는다)
SWEEP_NOREPO_DIRS=""   # 최상위를 못 받은 조회 폴더 — 저장소 아님 · 조회 실패(LF 줄 목록)

# sweep_query_dir <경로> — root_top · git_toplevel 이 git 에 묻는 폴더(`/.git` 앞 · 폴더면
# 그 자신 · 파일이면 부모)를 QUERY_DIR 에 담는다(서브셸 없이). 같은 폴더는 같은 답이다.
QUERY_DIR=""
sweep_query_dir() {
  case "$1" in
    */.git/*) QUERY_DIR="${1%%/.git/*}" ;;
    */.git) QUERY_DIR="${1%/.git}" ;;
    *) QUERY_DIR="${1%/*}" ;;
  esac
}

#######################################
# 경로가 이미 얻은 저장소 뿌리(SWEEP_BASE) 자신이거나 그 안이고, 그 사이에 다른 저장소의
# 표지(.git)도 심링크도 없는가 — 그러면 같은 뿌리라 git 최상위를 다시 묻지 않아도 된다.
# 표지가 있거나(중첩 저장소) 걸음에 심링크 성분이 있으면(뿌리 안 링크가 다른 저장소를
# 가리킬 수 있다) 아니라고 답해 git 이 실제 저장소를 찾게 한다. 최상위를 못 받은 폴더
# (SWEEP_NOREPO_DIRS)는 같은 문자열이면 같은 폴더라 다시 묻지 않는다. 여기에는 저장소
# 아님뿐 아니라 조회 실패(git 없음 · 권한 · 손상 · 소유권 거부)도 든다 — root_top 이 둘을
# 가르지 않는다. 결정적 실패는 다시 물어도 같은 답이지만, 같은 실행 안에서 다음 조회는
# 성공할 일시 실패였다면 같은 폴더 문자열의 뒤 토큰도 훑지 않는다(한계). 실패한 토큰을
# 알림 없이 버리는 것은 187398c 부터 같다.
# 뿌리 문자열(물리 경로)과 접두가 다른 표기(뿌리 밖 링크 경유)와 `..` 성분이 든 경로(문자열
# 접두가 물리 조상이 아니다 — `R/../b` 는 R 밖이다)는 아니라고 답한다 — 그때는
# git 을 부른다. "아니다"는 git 을 한 번 더 부를 뿐이고, "같은 뿌리다"만 판정을 바꾼다 —
# 그래서 "같은 뿌리다"는 걸음의 모든 성분이 링크도 다른 저장소도 아닐 때만 답한다.
# Globals:
#   SWEEP_BASE, SWEEP_NOREPO_DIRS (읽음) · QUERY_DIR (sweep_query_dir 가 씀)
# Arguments:
#   $1 — 경로(폴더는 `<폴더>/.` 꼴이어도 된다)
# Returns:
#   0 이미 얻은 뿌리 안 · 1 아님
#######################################
known_root_has() {
  local p="${1%/.}" rest="$SWEEP_BASE" r d
  sweep_query_dir "$1"
  case $'\n'"$SWEEP_NOREPO_DIRS" in *$'\n'"$QUERY_DIR"$'\n'*) return 0 ;; esac
  case "$p/" in */../*) return 1 ;; esac
  while [ -n "$rest" ]; do
    r="${rest%%$'\n'*}"
    case "$rest" in *$'\n'*) rest="${rest#*$'\n'}" ;; *) rest="" ;; esac
    [ -n "$r" ] || continue
    [ "$p" = "$r" ] && return 0
    case "$p" in "$r"/*) ;; *) continue ;; esac
    d="$p"
    while [ "$d" != "$r" ]; do
      { [ -h "$d" ] || [ -e "$d/.git" ]; } && return 1
      d="${d%/*}"
    done
    return 0
  done
  return 1
}
SWEEP_TOKEN_ROOTS=0    # 명령문 절대경로에서 얻은 뿌리 수(세션 루트·cwd 체크아웃 제외 — 상한)

# sweep_roots <명령문자열> — 스캔할 저장소 뿌리를 SWEEP_BASE(LF 줄 목록)에 정한다.
# 프로젝트는 언제나 포함한다. 하네스 정본은 **다른 클론**에서 고쳐지는 일이 잦으므로
# (이 파일 머리 주석의 2026-08-04 실사고), 명령문에 등장한 절대경로의 git 루트도 훑는다.
# 이건 명령 해석이 아니라 **탐색 범위 힌트**다 — 틀려도 프로젝트 스캔은 그대로 돈다.
# 훅 입력의 cwd 가 **같은 저장소의 다른 체크아웃**이면 그것도 훑는다. 세션 루트는 고정이라
# (_common.sh) 명령이 상대 cd 로 다른 체크아웃에 가서 쓴 파일은 루트 스캔에 안 걸리고, 그
# 경로가 명령문에 절대경로로 나오지도 않는다.
# 본 셸에서 돈다(전역에 담는다) — 명령문 경로 뿌리 수를 슬롯 상한이 이어 쓴다. 키가 없으면
# 목록은 예전 출력 그대로다. 슬롯이 켜졌으면:
#   · 최상위를 root_top 으로 받아 개행이 든 것은 빼고, 상한을 넘긴 토큰과 함께
#     SWEEP_ROOTS_PARTIAL 로 알린다. 같은 뿌리는 한 번만 센다.
#   · 토큰마다 시간 예산을 본다 — 넘으면 SWEEP_ROOTS_CUT 을 세우고 멈춘다(호출자가 스윕을
#     끊고 시간 절단을 알린다).
#   · git 을 부르기 전에 known_root_has 로 이미 아는 답(얻은 뿌리 안 · 최상위를 못 받은 폴더)을
#     찾아 같은 조회를 되풀이하지 않는다.
sweep_roots() {
  local cmd="$1" tok root
  SWEEP_BASE="$proj"$'\n'
  SWEEP_TOKEN_ROOTS=0
  if [ -n "$HARNESS_CWD" ] && [ -d "$HARNESS_CWD" ] && checkout_root_of "$HARNESS_CWD" \
      && [ "$CHECKOUT_ROOT" != "$proj" ]; then
    root="$CHECKOUT_ROOT"
    if [ "$EXTRA_ON" -eq 1 ]; then
      root=""
      root_top "$HARNESS_CWD/." && root="$ROOT_OUT"
    fi
    [ -n "$root" ] && SWEEP_BASE="$SWEEP_BASE$root"$'\n'
  fi
  for tok in $(abs_path_tokens "$cmd"); do
    # 키가 없으면 예전 그대로 토큰마다 세고 상한부터 본다(187398c 와 같은 뿌리 집합).
    if [ "$EXTRA_ON" -eq 0 ] && [ "$SWEEP_TOKEN_ROOTS" -ge "$SWEEP_MAX_ROOTS" ]; then
      break
    fi
    # 슬롯이 켜졌으면 뿌리 수집도 시간 예산을 본다 — 토큰이 아주 많으면 이 루프만으로
    # Bash 훅 상한(30 s)에 닿아 알림 없이 취소된다. 넘으면 스윕 전체를 끊고 알린다.
    if sweep_budget_spent; then
      SWEEP_ROOTS_CUT=1
      break
    fi
    # 지워진 경로(`rm <파일>`)는 남은 가장 가까운 조상으로, 디렉토리 토큰(`git -C <경로>`)은
    # 부모가 아니라 자신으로 조회한다 — git_toplevel 은 파일 경로의 dirname 을 묻는다([cx] r1).
    existing_ancestor "$tok"
    tok="$EXISTING"
    [ -n "$tok" ] || continue
    [ -d "$tok" ] && tok="$tok/."
    if [ "$EXTRA_ON" -eq 1 ]; then
      # 이미 얻은 뿌리 안이면 같은 뿌리다 — git 을 다시 부르지 않는다(같은 저장소 토큰이
      # 많을 때 토큰마다 git 을 부르던 비용).
      known_root_has "$tok" && continue
      if ! root_top "$tok"; then
        sweep_query_dir "$tok"
        SWEEP_NOREPO_DIRS="$SWEEP_NOREPO_DIRS$QUERY_DIR"$'\n'
        continue
      fi
      root="$ROOT_OUT"
    else
      root="$(git_toplevel "$tok")" || continue
    fi
    [ -n "$root" ] || continue
    [ "$root" = "$proj" ] && continue
    # 슬롯이 켜졌으면 같은 저장소를 가리키는 토큰 여럿은 뿌리 하나로 센다 — 공유 상한을
    # 먹어 다른 뿌리를 막거나 상한 알림을 잘못 내지 않게. 상한은 새 뿌리를 더할 때만 본다.
    if [ "$EXTRA_ON" -eq 1 ]; then
      case $'\n'"$SWEEP_BASE" in *$'\n'"$root"$'\n'*) continue ;; esac
      if [ "$SWEEP_TOKEN_ROOTS" -ge "$SWEEP_MAX_ROOTS" ]; then
        SWEEP_ROOTS_PARTIAL=1
        break
      fi
    fi
    SWEEP_BASE="$SWEEP_BASE$root"$'\n'
    SWEEP_TOKEN_ROOTS=$((SWEEP_TOKEN_ROOTS + 1))
  done
}

# --- 추가 관할 폴더 스윕 뿌리 (슬롯이 켜졌을 때만 — ADR-0026) --------------------------
#
# 위 뿌리에 더한다: cwd 의 슬롯 저장소(세션 루트가 git 밖이면 위 cwd 뿌리가 못 잡는다),
# 홈 기준 토큰(~/ 꼴)의 슬롯 저장소, cwd·토큰의 가장 가까운 _workspace* 조상(작업 공간
# 뿌리 — 물리화), 그리고 쌍(저장소 T ↔ 형제 _workspace_T). 넓히는 곳은 슬롯 안·세션
# 루트 밖뿐이고 슬롯 자신은 뿌리가 아니다 — 슬롯 전체는 훑지 않는다(다른 트랙의 쓰기를
# 잡지 않게).
# 상한: 명령문 토큰에서 얻은 뿌리(절대경로 저장소 · 홈 토큰 저장소 · 작업 공간)는
# SWEEP_MAX_ROOTS 하나를 함께 쓰고, 넘으면 알린다. 같은 뿌리는 한 번만 센다. 쌍은 원천
# 하나에 하나라 따로 세지 않고, cwd 에서 얻은 뿌리도 세지 않는다(저장소·작업 공간 하나씩).
# 뿌리 경로는 root_dir · root_top 으로만 얻는다 — 개행이 든 뿌리는 목록에 들어가지 않는다.
SLOT_REPO_ROOTS=""      # 더할 저장소 뿌리(LF 줄 목록, 물리 경로 — 개행 없음)
SLOT_WS_ROOTS=""        # 작업 공간 뿌리(LF 줄 목록, 물리 경로 — 개행 없음)
SWEEP_ROOTS_PARTIAL=0   # 뿌리를 다 훑지 못했다(상한 · 홈 토큰 추출 실패 · 개행 · 입력 유실)
SLOT_UNITS=0            # 상한에 센 뿌리 수(SWEEP_TOKEN_ROOTS 에서 시작)
SLOT_PAIR_REPOS=""      # 명령문 토큰의 쌍으로만 얻은 저장소(LF 줄 목록) — 창 기반 find 만
SLOT_CWD_WS=""          # cwd 에서 얻은 작업 공간 뿌리(그 쌍은 삭제 판정을 유지한다)
JUDGED=""               # 작업 공간 뿌리에서 판정한 경로(LF 줄 목록 — 개행 없는 것만)
ROOT_OUT=""             # root_dir · root_top 의 결과

# listed_same <목록> <경로> — LF 줄 목록에 같은 파일·폴더(-ef)가 있는가. 표기와 무관하다.
listed_same() {
  local rest="$1" d
  while [ -n "$rest" ]; do
    d="${rest%%$'\n'*}"
    case "$rest" in *$'\n'*) rest="${rest#*$'\n'}" ;; *) rest="" ;; esac
    [ -n "$d" ] && [ "$d" -ef "$2" ] && return 0
  done
  return 1
}

#######################################
# 스윕 뿌리용 물리화 — 폴더를 물리 경로로 풀어 ROOT_OUT 에 담는다. 끝 개행까지 센티널로
# 받는다: 명령 치환은 끝 개행을 지워 이름이 같은 다른 폴더(다른 트랙)를 가리키고, 가운데
# 개행은 LF 줄 목록을 쪼갠다. 개행이 든 경로는 뿌리로 쓰지 않고 알린다.
# Globals:
#   ROOT_OUT, SWEEP_ROOTS_PARTIAL (씀)
# Arguments:
#   $1 — 폴더
# Returns:
#   0 · 1 풀 수 없음, 또는 개행(그때 SWEEP_ROOTS_PARTIAL=1)
#######################################
root_dir() {
  local out
  ROOT_OUT=""
  out="$(CDPATH='' cd -P -- "$1" 2>/dev/null && pwd -P && printf x)" || return 1
  out="${out%x}"
  out="${out%$'\n'}"
  case "$out" in
    *$'\n'*) SWEEP_ROOTS_PARTIAL=1; return 1 ;;
  esac
  [ -n "$out" ] || return 1
  ROOT_OUT="$out"
}

#######################################
# 스윕 뿌리용 git 최상위 — 그 경로가 속한 저장소의 최상위를 root_dir 로 물리화해 ROOT_OUT
# 에 담는다. 묻는 폴더는 git_toplevel 과 같다(`/.git` 앞, 아니면 마지막 성분의 부모 —
# 폴더는 `<폴더>/.` 로 넘긴다). git 출력도 센티널로 받는다.
# Globals:
#   ROOT_OUT, SWEEP_ROOTS_PARTIAL (root_dir 가 씀)
# Arguments:
#   $1 — 절대경로
# Returns:
#   0 · 1 저장소 아님·조회 실패, 또는 개행
#######################################
root_top() {
  local dir top
  ROOT_OUT=""
  case "$1" in
    */.git/*) dir="${1%%/.git/*}" ;;
    */.git) dir="${1%/.git}" ;;
    *) dir="${1%/*}" ;;
  esac
  top="$(git -C "${dir:-/}" rev-parse --show-toplevel 2>/dev/null && printf x)" \
    || return 1
  top="${top%x}"
  top="${top%$'\n'}"
  [ -n "$top" ] || return 1
  root_dir "$top"
}

#######################################
# 상한에 세는 뿌리면 자리가 남았는가. 넘으면 알림 표시를 세운다.
# Globals:
#   SLOT_UNITS, SWEEP_MAX_ROOTS (읽음) · SWEEP_ROOTS_PARTIAL (씀)
# Arguments:
#   $1 — 상한에 세는가(1 명령문 토큰 · 0 cwd·쌍)
# Returns:
#   0 더해도 됨 · 1 상한
#######################################
slot_room() {
  [ "$1" -eq 1 ] || return 0
  [ "$SLOT_UNITS" -lt "$SWEEP_MAX_ROOTS" ] && return 0
  SWEEP_ROOTS_PARTIAL=1
  return 1
}

#######################################
# 저장소 최상위가 슬롯 안·세션 루트 밖이고 처음 보는 것이면 저장소 뿌리로 더한다.
# Globals:
#   proj, SWEEP_BASE (읽음) · SLOT_REPO_ROOTS, SLOT_UNITS (씀)
# Arguments:
#   $1 — 물리 최상위, $2 — 상한에 세는가(1 · 0)
# Returns:
#   0 더함·이미 있음 · 1 해당 없음·상한
#######################################
push_slot_repo() {
  is_slot_entry "$1" "$proj" || return 1
  listed_same "$SWEEP_BASE$SLOT_REPO_ROOTS" "$1" && return 0
  slot_room "$2" || return 1
  SLOT_REPO_ROOTS="$SLOT_REPO_ROOTS$1"$'\n'
  [ "$2" -eq 0 ] || SLOT_UNITS=$((SLOT_UNITS + 1))
}

#######################################
# 경로가 속한 git 저장소를 저장소 뿌리로 더한다(push_slot_repo). 지워진 경로는 남은 가장
# 가까운 조상으로 묻는다(sweep_roots 와 같은 관용구).
# Globals:
#   EXISTING, ROOT_OUT (씀)
# Arguments:
#   $1 — 경로, $2 — 상한에 세는가(1 · 0)
# Returns:
#   0 더함·이미 있음 · 1 해당 없음·상한
#######################################
add_slot_repo() {
  local q
  existing_ancestor "$1"
  [ -n "$EXISTING" ] || return 1
  q="$EXISTING"
  [ -d "$q" ] && q="$q/."
  root_top "$q" || return 1
  push_slot_repo "$ROOT_OUT" "$2"
}

#######################################
# 경로의 가장 가까운 _workspace·_workspace_* 조상(대소문자 무관)을 물리화해 작업 공간
# 뿌리로 더한다. 조상 걸음은 슬롯 경계 안쪽에서 멈춘다 — 슬롯 자신은(이름이 _workspace*
# 여도, 슬롯을 가리키는 링크여도) 작업 공간 뿌리가 아니다(슬롯 전체를 훑지 않는다).
# 물리화가 먼저다 — 시작점이 심링크면 find 가 따라가지 않고, 슬롯 안 링크가 슬롯 밖을
# 가리키면 뿌리가 아니다.
# Globals:
#   EXTRA_GATE_DIR, proj (읽음) · ROOT_OUT, SLOT_WS_ROOTS, SLOT_UNITS (씀)
# Arguments:
#   $1 — 경로, $2 — 상한에 세는가(1 · 0)
# Returns:
#   0 더함·이미 있음 · 1 해당 없음·상한
#######################################
add_slot_ws() {
  local p="$1" w="" was_set=0
  # 절대경로만 걷는다 — 상대경로(훅 입력 cwd `.`)는 성분을 떼도 문자열이 줄지 않는다.
  case "$p" in /*) ;; *) return 1 ;; esac
  shopt -q nocasematch && was_set=1
  shopt -s nocasematch
  while [ -n "$p" ]; do
    [ "$p" -ef "$EXTRA_GATE_DIR" ] && break
    case "${p##*/}" in
      _workspace | _workspace_*) w="$p"; break ;;
    esac
    [ "${p%/*}" != "$p" ] || break   # 줄지 않으면 멈춘다(끝나지 않는 걸음 방지)
    p="${p%/*}"
  done
  [ "$was_set" -eq 1 ] || shopt -u nocasematch
  [ -n "$w" ] || return 1
  root_dir "$w" || return 1
  is_slot_entry "$ROOT_OUT" "$proj" || return 1
  listed_same "$SLOT_WS_ROOTS" "$ROOT_OUT" && return 0
  slot_room "$2" || return 1
  SLOT_WS_ROOTS="$SLOT_WS_ROOTS$ROOT_OUT"$'\n'
  [ "$2" -eq 0 ] || SLOT_UNITS=$((SLOT_UNITS + 1))
}

#######################################
# 훅 입력의 cwd 를 끝 개행까지 다시 읽는다(센티널). 진입부의 명령 치환은 끝 개행을 지워
# 이름이 같은 다른 폴더(다른 트랙)를 가리키고, 가운데 개행은 뿌리 목록을 쪼갠다 — 개행이
# 든 cwd 는 이번 스윕의 뿌리 근원에서 빼고(HARNESS_CWD 를 비운다 — 스윕은 절대경로만
# 판정한다) 알린다. 슬롯이 켜졌을 때만 부른다(키가 없을 때의 동작은 예전 그대로).
# Globals:
#   payload (읽음) · HARNESS_CWD, SWEEP_ROOTS_PARTIAL (씀)
#######################################
slot_cwd_check() {
  local raw
  [ -n "$HARNESS_CWD" ] || return 0
  raw="$(printf '%s' "$payload" | json_get cwd; printf x)"
  raw="${raw%x}"
  raw="${raw%$'\n'}"
  case "$raw" in
    *$'\n'*) HARNESS_CWD=""; SWEEP_ROOTS_PARTIAL=1 ;;
  esac
}

#######################################
# 슬롯 스윕 뿌리를 정한다(본 셸에서 — 전역에 담는다). 후보는 cwd · 절대경로 토큰 ·
# 홈 토큰이다. 홈 토큰 추출이 실패하거나(rc 2) 펼치지 못한 홈 토큰이 있으면(rc 3) 빈
# 성공으로 받지 않고 알림 표시를 세운다. 토큰 순회 중 시간 예산이 끝나면 SWEEP_ROOTS_CUT
# 을 세우고 돌아온다(호출자가 스윕을 끊는다).
# Globals:
#   HARNESS_CWD, SWEEP_TOKEN_ROOTS (읽음) · SLOT_REPO_ROOTS, SLOT_WS_ROOTS, SLOT_UNITS,
#   SLOT_PAIR_REPOS, SLOT_CWD_WS, SWEEP_ROOTS_PARTIAL, SWEEP_ROOTS_CUT (씀)
# Arguments:
#   $1 — 명령문
#######################################
slot_sweep_roots() {
  local cmd="$1" toks tok rest
  SLOT_REPO_ROOTS=""
  SLOT_WS_ROOTS=""
  SLOT_UNITS="$SWEEP_TOKEN_ROOTS"
  SLOT_PAIR_REPOS=""
  SLOT_CWD_WS=""
  if [ -n "$HARNESS_CWD" ] && [ -d "$HARNESS_CWD" ]; then
    add_slot_repo "$HARNESS_CWD" 0
    add_slot_ws "$HARNESS_CWD" 0 && SLOT_CWD_WS="$ROOT_OUT"
  fi
  for tok in $(abs_path_tokens "$cmd"); do
    if sweep_budget_spent; then
      SWEEP_ROOTS_CUT=1
      return 0
    fi
    add_slot_ws "$tok" 1
  done
  toks="$(home_path_tokens "$cmd")" || SWEEP_ROOTS_PARTIAL=1
  rest="$toks"$'\n'
  while [ -n "$rest" ]; do
    tok="${rest%%$'\n'*}"
    case "$rest" in *$'\n'*) rest="${rest#*$'\n'}" ;; *) rest="" ;; esac
    [ -n "$tok" ] || continue
    if sweep_budget_spent; then
      SWEEP_ROOTS_CUT=1
      return 0
    fi
    add_slot_ws "$tok" 1
    add_slot_repo "$tok" 1
  done
  slot_pair_roots
}

#######################################
# 쌍 뿌리 — 슬롯 안 저장소 뿌리 T 의 형제 작업 공간과, 작업 공간 뿌리 W 의 형제
# 저장소(git 최상위가 바로 그 폴더일 때)를 더한다. 쌍은 원천 하나에 하나라 상한에 세지
# 않는다(원천이 상한 아래이므로 쌍도 그 아래다). 명령문 토큰의 작업 공간에서 얻은 쌍
# 저장소는 SLOT_PAIR_REPOS 에 적어 삭제 판정에서 뺀다 — cwd 작업 공간의 쌍은 빼지 않는다.
# Globals:
#   SWEEP_BASE, SLOT_CWD_WS (읽음) · SLOT_REPO_ROOTS, SLOT_WS_ROOTS (읽고 씀) ·
#   ROOT_OUT, SLOT_PAIR_REPOS (씀)
#######################################
slot_pair_roots() {
  local rest="$SWEEP_BASE$SLOT_REPO_ROOTS" r t
  while [ -n "$rest" ]; do
    r="${rest%%$'\n'*}"
    case "$rest" in *$'\n'*) rest="${rest#*$'\n'}" ;; *) rest="" ;; esac
    [ -n "$r" ] && is_slot_entry "$r" "$proj" || continue
    t="$(sibling_workspace_of "$r")" && [ -d "$t" ] && add_slot_ws "$t" 0
  done
  rest="$SLOT_WS_ROOTS"
  while [ -n "$rest" ]; do
    r="${rest%%$'\n'*}"
    case "$rest" in *$'\n'*) rest="${rest#*$'\n'}" ;; *) rest="" ;; esac
    t="$(sibling_repo_of "$r")" && [ -d "$t" ] || continue
    root_top "$t/." && [ "$ROOT_OUT" -ef "$t" ] || continue
    listed_same "$SWEEP_BASE$SLOT_REPO_ROOTS" "$ROOT_OUT" && continue
    push_slot_repo "$ROOT_OUT" 0 || continue
    # cwd 작업 공간의 쌍은 cwd 저장소처럼 삭제 판정을 한다(`rm ../T/x` 를 놓치지 않게).
    # 명령문 토큰에서 얻은 쌍만 창 기반 find 로 한정한다(SLOT_PAIR_REPOS).
    [ "$r" = "$SLOT_CWD_WS" ] || SLOT_PAIR_REPOS="$SLOT_PAIR_REPOS$ROOT_OUT"$'\n'
  done
}

#######################################
# 슬롯이 켜졌고 시간 예산을 다 썼는가(훅 시작부터 — SECONDS). 다 썼으면 절단 문구를
# 가르도록 SWEEP_TIME_CUT 을 세운다(부수효과).
# Globals:
#   EXTRA_ON, SECONDS, SWEEP_BUDGET (읽음) · SWEEP_TIME_CUT (씀)
# Returns:
#   0 다 씀 · 1 남음(키가 없으면 늘 1 — 예전 동작 그대로)
#######################################
sweep_budget_spent() {
  [ "$EXTRA_ON" -eq 1 ] && [ "$SECONDS" -ge "$SWEEP_BUDGET" ] || return 1
  SWEEP_TIME_CUT=1
}

#######################################
# 순회 입력이 끝 표지 없이 끝났다(리다이렉트 실패 · 생산자 사망) — 그 뿌리를 다 못 훑었다.
# 슬롯이 켜졌으면 알리고 창을 남겨 다음 Bash 가 다시 훑게 한다. 키가 없으면 예전처럼
# 아무것도 하지 않는다(키가 없을 때의 동작은 예전 그대로).
# Globals:
#   EXTRA_ON (읽음) · SWEEP_ROOTS_PARTIAL, SWEEP_KEEP_WINDOW (씀)
#######################################
sweep_stream_lost() {
  [ "$EXTRA_ON" -eq 1 ] || return 0
  SWEEP_ROOTS_PARTIAL=1
  SWEEP_KEEP_WINDOW=1
}

# judged_in_ws <경로> — 작업 공간 뿌리 루프가 이미 판정한 경로인가. 정확히 같은 줄을 찾는다
# — 두 루프의 경로는 같은 물리 표기다(뿌리는 pwd -P · git 이, 그 아래는 find 가 디스크
# 이름으로 낸다). 개행이 든 경로는 JUDGED 에 없다.
judged_in_ws() {
  case "$1" in *$'\n'*) return 1 ;; esac
  case $'\n'"$JUDGED" in *$'\n'"$1"$'\n'*) return 0 ;; esac
  return 1
}

#######################################
# 작업 공간 뿌리를 먼저 돈다 — 그 폴더 바로 아래의 설계 모양만 판정하고 무시·status 판정을
# 돌리지 않는다(바깥 저장소의 경로를 그 저장소 판정으로 읽지 않게). 판정한 경로는
# JUDGED 에 모아 저장소 뿌리가 다시 판정하지 않게 한다. 시간 예산·끝 표지는 저장소 뿌리
# 루프와 같다(예산은 레코드마다 모양 필터보다 먼저 본다).
# 호출자(sweep_bash_writes)의 지역 변수 n · truncated · file_msg 를 갱신한다(bash 동적
# 범위 — 판정 수 상한을 저장소 뿌리와 함께 센다).
# Globals:
#   SLOT_WS_ROOTS, SWEEP_MAX, SWEEP_END (읽음) · JUDGED (씀)
#######################################
sweep_workspace_roots() {
  local rest="$SLOT_WS_ROOTS" root f ended
  while [ -n "$rest" ]; do
    root="${rest%%$'\n'*}"
    case "$rest" in *$'\n'*) rest="${rest#*$'\n'}" ;; *) rest="" ;; esac
    [ -n "$root" ] || continue
    ended=0
    while IFS= read -r -d '' f; do
      [ "$f" = "$SWEEP_END" ] && { ended=1; break; }
      # 시간 예산은 모양 필터보다 먼저 본다 — 비설계 파일만 아주 많아도 이 루프가 끊긴다.
      if sweep_budget_spent; then truncated=1; return 0; fi
      is_design_shaped "$f" || continue
      n=$((n + 1))
      if [ "$n" -gt "$SWEEP_MAX" ]; then truncated=1; return 0; fi
      judge_file "$f"
      [ -n "$JUDGE_MSG" ] && file_msg=1
      case "$f" in *$'\n'*) ;; *) JUDGED="$JUDGED$f"$'\n' ;; esac
    done < <(sweep_find "$root" ws; printf '%s\0' "$SWEEP_END")
    [ "$ended" -eq 1 ] || sweep_stream_lost
  done
}

#######################################
# 저장소 뿌리 하나를 훑는다 — 창 이후 바뀐 파일과 git 이 아는 삭제를 judge_file 로.
# 호출자(sweep_bash_writes)의 지역 변수 n · truncated · file_msg 를 갱신한다(동적 범위).
# 상한·시간 예산에 닿으면 truncated=1 로 돌아온다. 명령문 토큰의 쌍으로만 얻은 저장소
# (SLOT_PAIR_REPOS)는 git status 삭제 판정을 하지 않는다.
# Globals:
#   EXTRA_ON, JUDGED, proj, SWEEP_MAX, SWEEP_END, SLOT_PAIR_REPOS (읽음)
# Arguments:
#   $1 — 저장소 뿌리
#######################################
sweep_repo_root() {
  local root="$1" f st ended=0
  # 목록을 **한 번만** 만든다. 예전엔 무시 목록용과 본 루프용으로 find 를 두 번 돌렸는데,
  # 그 사이에 생긴 파일이 무시 목록에 없는 채로 본 루프에 잡혔다([cc] r1 지적).
  # 무시 여부는 파일마다 git 에 직접 묻는다 — 목록을 문자열로 들고 다니면 개행·NUL 이
  # 든 파일명에서 다시 깨진다. 대상이 보통 몇 개라 비용보다 정확성을 택했다.
  # 끝 표지까지 읽어야 다 읽은 것이다 — 리다이렉트가 실패하면 0줄이다(실패가 성공으로 새는 부류).
  while IFS= read -r -d '' f; do
    [ "$f" = "$SWEEP_END" ] && { ended=1; break; }
    [ -n "$f" ] || continue
    # 시간 예산은 무시 판정보다 먼저 본다 — check-ignore 도 시간을 쓴다(판정 수 상한에는
    # 세지 않는다: 그 수는 판정 수이고, 키가 없을 때의 절단 시점이 바뀐다).
    if sweep_budget_spent; then truncated=1; return 0; fi
    # 슬롯: 루트 밖·슬롯 안의 설계 모양은 무시 판정 앞에서 판정한다(무시된 트랙 작업
    # 공간도 잡는다). 작업 공간 뿌리가 이미 판정했으면 건너뛴다(중복 판정 없음).
    if [ "$EXTRA_ON" -eq 1 ] && is_design_shaped "$f"; then
      judged_in_ws "$f" && continue
      if is_slot_entry "$f" "$proj"; then
        n=$((n + 1))
        if [ "$n" -gt "$SWEEP_MAX" ]; then truncated=1; return 0; fi
        judge_file "$f"
        [ -n "$JUDGE_MSG" ] && file_msg=1
        continue
      fi
    fi
    git -C "$root" check-ignore -q -- "$f" 2>/dev/null && continue
    n=$((n + 1))
    if [ "$n" -gt "$SWEEP_MAX" ]; then truncated=1; return 0; fi
    # 판정이 낸 알림을 **버리지 않는다.** 개행이 든 경로처럼 "기록을 포기했다"는 알림이
    # 있는데, 삼키면 이 훅의 fail-loud 계약이 스윕 경로에서만 사라진다. 파일마다 내면
    # stdout 에 여러 줄이 나가므로(PostToolUse 는 한 줄 계약) **있었다는 사실만** 모아
    # 아래에서 한 번 알린다.
    judge_file "$f"
    [ -n "$JUDGE_MSG" ] && file_msg=1
  done < <(sweep_find "$root"; printf '%s\0' "$SWEEP_END")
  [ "$ended" -eq 1 ] || sweep_stream_lost

  # **삭제는 find 로 못 본다** — `-type f` 는 없는 파일을 찾을 수 없다(codex r1 CRITICAL).
  # `rm src/auth.go` 가 게이트를 그대로 통과하던 구멍이다. git 이 아는 삭제만 잡는다:
  # 추적되지 않던 파일의 삭제는 어차피 아무도 모른다.
  # 시간 창을 못 걸므로 **이전에 생긴 미커밋 삭제도 잡힌다** — 과탐이지만, 미커밋 삭제가
  # 남아 있다는 것 자체가 감사가 필요한 상태라 그대로 둔다.
  #
  # **-z 가 필수다.** 기본 porcelain 은 특수문자 경로를 따옴표로 감싸고 이스케이프한다.
  # 실측: `src/say"hi".go` → `"src/say\"hi\".go"`, 한글 경로 → `"src/\355\225\234…"`.
  # 그대로 쓰면 **존재하지 않는 경로**가 플래그에 박히고 실제 파일은 무게이트다 —
  # 한국어 파일명을 쓰는 저장소에서는 상시 조건이다(codex r2 지적, [cc] 실측).
  # -z 는 인용 없이 NUL 로 끊어 준다. 레코드 = 상태 2글자 + 공백 + 경로.
  # git 이 실패해도(저장소 아님) 끝 표지는 온다 — 표지가 없을 때만 입력 유실이다.
  # 쌍 추론으로만 얻은 저장소는 건너뛴다 — 명령이 가리킨 곳이 아니라 그 형제라, 창과
  # 무관한 미커밋 삭제를 판정하면 다른 트랙의 삭제까지 이 세션 의무가 된다.
  case $'\n'"$SLOT_PAIR_REPOS" in *$'\n'"$root"$'\n'*) return 0 ;; esac
  ended=0
  while IFS= read -r -d '' st; do
    [ "$st" = "$SWEEP_END" ] && { ended=1; break; }
    case "$st" in
      ' D '*|'D  '*|'AD '*|'MD '*) ;;
      *) continue ;;
    esac
    f="${st:3}"
    [ -n "$f" ] || continue
    if sweep_budget_spent; then truncated=1; return 0; fi
    n=$((n + 1))
    if [ "$n" -gt "$SWEEP_MAX" ]; then truncated=1; return 0; fi
    judge_file "$root/$f"
    [ -n "$JUDGE_MSG" ] && file_msg=1
  done < <(git -C "$root" status --porcelain -z 2>/dev/null; printf '%s\0' "$SWEEP_END")
  [ "$ended" -eq 1 ] || sweep_stream_lost
}

# sweep_bash_writes <명령문자열> — 표식 이후 바뀐 파일을 찾아 judge_file 로 판정한다.
sweep_bash_writes() {
  local cmd="$1" root n=0 seen="" truncated=0 file_msg=0 rest

  # **가장 오래된 창을 소비한다.** 병렬 Bash 에서 창이 여럿일 수 있는데, 짝을 정확히
  # 맞출 방법이 없으므로 **가장 넓은 창**을 쓴다 — 남의 호출이 쓴 파일까지 잡는 과탐은
  # 싸고, 놓치는 누락은 비싸다(codex r1 CRITICAL).
  #
  # **소비한 창은 반드시 지운다(아래 consume).** 안 지우면 창이 쌓여 매번 세션 맨 처음
  # 창을 쓰게 되고, 감사자가 플래그를 지워도 다음 Bash 가 같은 파일을 다시 세워
  # **게이트가 영원히 안 닫힌다 — 세션이 벽돌이 된다.** r1 수정이 만든 2차 결함이라
  # 여기 못 박는다([cc] r2).
  #
  # ls -tr 은 **mtime 오름차순**이다(-t 가 mtime, -r 이 역순). 창 파일명은 우리가 짓고
  # 공백·개행이 없으므로 ls 출력을 줄 단위로 읽어도 안전하다.
  BASH_WINDOW="$(ls -tr "$WINDOW_DIR" 2>/dev/null | head -n 1)"
  [ -n "$BASH_WINDOW" ] || return 0     # 창이 없으면(PreToolUse 미등록) 스윕하지 않는다
  BASH_WINDOW="$WINDOW_DIR/$BASH_WINDOW"
  [ -f "$BASH_WINDOW" ] || return 0

  [ "$EXTRA_ON" -eq 1 ] && slot_cwd_check
  sweep_roots "$cmd"
  [ "$SWEEP_ROOTS_CUT" -eq 1 ] && truncated=1
  if [ "$EXTRA_ON" -eq 1 ] && [ "$truncated" -eq 0 ]; then
    slot_sweep_roots "$cmd"
    if [ "$SWEEP_ROOTS_CUT" -eq 1 ]; then
      truncated=1
    else
      sweep_workspace_roots
    fi
  fi

  # 뿌리 목록은 매개변수 확장으로 돈다 — 히어독은 임시 파일이라 그것을 못 만들면(디스크
  # 참·ulimit) 0회 돌고 창만 소비해 무기록·무알림이 된다(실패가 성공으로 새는 부류).
  # 목록과 seen 은 LF 줄 목록이다. 개행은 경로에 들 수 있다 — 슬롯이 켜졌을 때는 개행이 든
  # 뿌리가 목록에 들어가지 않고(root_dir · root_top), 키가 없으면 예전 동작 그대로다.
  rest="$SWEEP_BASE$SLOT_REPO_ROOTS"
  [ "$truncated" -eq 1 ] && rest=""
  while [ -n "$rest" ]; do
    root="${rest%%$'\n'*}"
    case "$rest" in *$'\n'*) rest="${rest#*$'\n'}" ;; *) rest="" ;; esac
    [ -n "$root" ] || continue
    # 슬롯이 켜졌으면 줄 단위 정확 일치로 거른다 — 앞 뿌리의 접미가 뒤 뿌리와 같아도
    # 뒤 뿌리를 건너뛰지 않게. 키가 없으면 예전 비교 그대로다(187398c 와 같은 뿌리 집합).
    if [ "$EXTRA_ON" -eq 1 ]; then
      case $'\n'"$seen" in *$'\n'"$root"$'\n'*) continue ;; esac
    else
      case "$seen" in *"$root"$'\n'*) continue ;; esac
    fi
    seen="$seen$root"$'\n'
    sweep_repo_root "$root"
    [ "$truncated" -eq 1 ] && break
  done

  # 창을 소비했으니 지운다. 이 줄이 없으면 위 주석의 벽돌 상태가 된다. 단 순회 입력을
  # 다 읽지 못했으면(sweep_stream_lost) 남긴다 — 다음 Bash 가 같은 창으로 다시 훑는다.
  [ "$SWEEP_KEEP_WINDOW" -eq 1 ] || rm -f "$BASH_WINDOW" 2>/dev/null

  # 조용히 끊으면 사용자는 게이트가 다 섰다고 믿는데 실제로는 아니다 — 이 훅이 위음성을
  # 대하는 방식(fail-loud)과 어긋난다. 메시지는 **하나로** 정하고, 출력은 finish_hook 이
  # 한 번만 한다(PostToolUse 계약 — JSON 한 줄).
  if [ "$truncated" -eq 1 ] && [ "$SWEEP_TIME_CUT" -eq 1 ]; then
    SWEEP_MSG="$MSG_SWEEP_TIME_CUT"
  elif [ "$truncated" -eq 1 ]; then
    SWEEP_MSG="$MSG_SWEEP_TRUNCATED"
  elif [ "$file_msg" -eq 1 ]; then
    SWEEP_MSG="$MSG_SWEEP_PARTIAL"
  fi
  if [ "$EXTRA_ON" -eq 1 ] && [ "$SWEEP_ROOTS_PARTIAL" -eq 1 ]; then
    SWEEP_MSG="${SWEEP_MSG:+$SWEEP_MSG }$MSG_SWEEP_ROOT_CAP"
  fi
  # 파일 하나의 판정 알림은 위 집계로 접혔다. 남겨 두면 마지막 파일의 알림이 출구에서
  # 집계와 섞여 키가 없을 때의 바이트가 달라진다. 리뷰 자리 기록 알림(RECORD_MSG)은
  # 접지 않는다 — 막힘과 출구가 사유마다 달라 출구(finish_hook)가 그대로 붙인다.
  JUDGE_MSG=""
  return 0
}

# --- 판정 -----------------------------------------------------------------

JUDGE_MSG=""   # judge_file 이 알릴 메시지(없으면 빈 값). 출력은 호출자가 한 번만 낸다.
VALUE=""       # verdict_of 의 결과 — 기록값
VERDICT=""     # verdict_of 의 결과 — gate · knowledge · skip
VERDICT_REPO=""  # verdict_of 의 결과 — 분류 기준 저장소 최상위(①③④⑤′, 없으면 빈 값)
REPO_TOP=""      # repo_top_of 의 결과
RECORDING=0      # 이번 판정이 리뷰 자리를 기록하는가(슬롯 켜짐 ∧ 절대 값)
RECORD_PERMANENT=0  # 이번 판정의 값을 기록할 수 없는가(갱신 표시부터 영구 실패)

# other_checkout <물리 절대경로> — 그 파일이 세션 루트($proj)가 아닌 **같은 저장소의 다른
# 체크아웃**(메인·형제 워크트리) 안이면 CHECKOUT_ROOT 에 그 최상위를 담고 rc=0.
#
# 왜: 세션 루트는 하나로 고정된다(_common.sh). W 세션이 메인 파일을 고치면 그 파일은 루트 밖이라
# "밖 + 정본 아님"으로 조용히 빠졌고([cc] r1 #2), M 세션이 <메인>/.claude/worktrees/ 아래 워크트리
# 파일을 고치면 `.claude/*` 로 분류돼 빠졌다. 두 경우 모두 그 체크아웃 기준으로 분류하고 **이
# 세션의 의무**로 적는다(kty 결정 2026-10-02 — 무기록 금지).
# 루트 안 파일은 git 을 부르기 전에 조상의 `.git` 을 먼저 본다 — 스윕은 파일이 수백 개일 수 있다.
other_checkout() {
  local d
  case "$1" in
    "$proj"/*)
      d="${1%/*}"
      while [ "$d" != "$proj" ] && [ ! -e "$d/.git" ]; do d="${d%/*}"; done
      [ "$d" != "$proj" ] || return 1
      checkout_root_of "$d" && [ "$CHECKOUT_ROOT" = "$d" ] ;;
    *)
      existing_ancestor "${1%/*}"
      [ -n "$EXISTING" ] && checkout_root_of "$EXISTING" && [ "$CHECKOUT_ROOT" != "$proj" ] ;;
  esac
}

#######################################
# 그 파일의 git 최상위(④·⑤′ 공용) — ③ 이 구한 최상위를 재사용하고, 폴더째 지워진 파일은
# 남아 있는 가장 가까운 조상으로 묻는다(other_checkout 과 같은 관용구).
# Globals:
#   EXISTING (existing_ancestor 가 씀) · REPO_TOP (씀)
# Arguments:
#   $1 — 물리 절대경로, $2 — ③ 이 구한 최상위(빈 값일 수 있다)
# Returns:
#   0 찾음 · 1 없음
#######################################
repo_top_of() {
  REPO_TOP="${2:-}"
  if [ -z "$REPO_TOP" ] && [ ! -d "${1%/*}" ]; then
    existing_ancestor "${1%/*}"
    REPO_TOP=""
    [ -n "$EXISTING" ] && REPO_TOP="$(git_toplevel "$EXISTING/.")"
  fi
  [ -n "$REPO_TOP" ]
}

# verdict_of <물리 절대경로> — 기록값(VALUE)·판정(VERDICT)·분류 기준 저장소(VERDICT_REPO).
# 기록값: 세션 루트 안은 상대경로, 밖(다른 체크아웃 포함)은 **절대경로**.
# 순서가 계약이다: ① 다른 체크아웃 ② 세션 루트 안 ③ 밖 + 하네스 정본 ④ 밖 + .claude 앵커
# ⑤′ 밖 + 추가 관할 폴더 저장소 ⑥ 그 밖 skip. ⑤′ 는 ④ 뒤에만 둔다 — 앞에 두면 슬롯
# 저장소의 .claude/ 앵커 파일을 classify 가 `.claude/*` 로 빼서 조용히 사라진다(ADR-0007).
verdict_of() {
  local abs="$1" rel root
  VALUE="$abs"
  VERDICT_REPO=""
  if other_checkout "$abs"; then
    VERDICT_REPO="$CHECKOUT_ROOT"
    VERDICT="$(classify "${abs#"$CHECKOUT_ROOT"/}" "$CHECKOUT_ROOT")"
  elif rel="$(project_rel "$abs")"; then
    VALUE="$rel"
    VERDICT="$(classify "$rel" "$proj")"
  else
    root="$(git_toplevel "$abs")" || root=''
    if [ -n "$root" ] && is_harness_canonical "$root"; then
      VERDICT_REPO="$root"
      case "$abs" in
        "$root"/*) rel="${abs#"$root"/}" ;;
        *) rel="$abs" ;;
      esac
      VERDICT="$(classify "$rel" "$root")"
    elif harness_anchor "$abs"; then
      # 앵커 판정에 git 을 요구하지 않는다 — 홈에 설치된 .claude/agents/*.md 는
      # 그 디렉토리가 git 저장소가 아니어도 하네스 동작을 정의한다. 분류 기준 저장소는
      # 그 파일의 git 최상위다(git 밖이면 빈 값 — 리뷰 자리는 빈 집합).
      VERDICT_REPO="$root"
      [ "$EXTRA_ON" -eq 1 ] && repo_top_of "$abs" "$root" \
        && VERDICT_REPO="$REPO_TOP"
      VERDICT='gate'
    elif [ "$EXTRA_ON" -eq 1 ] && is_slot_entry "$abs" "$proj" \
        && repo_top_of "$abs" "$root" && in_extra_gate_dir "$REPO_TOP"; then
      # ⑤′ 추가 관할 폴더(사용자 옵트인 선언). 폴더 안 분류는 classify 가 한다. 상대경로는
      # 같은 폴더 접두로 자른다 — git 은 디스크 표기, 편집 경로는 입력 표기일 수 있다.
      VERDICT_REPO="$REPO_TOP"
      find_same_dir_prefix "$abs" "$REPO_TOP" || SAME_DIR_PREFIX="$REPO_TOP"
      VERDICT="$(classify "${abs#"$SAME_DIR_PREFIX"/}" "$REPO_TOP")"
    else
      VERDICT='skip'
      # git 이 빈 값을 돌려줬는데 조상에 .git 이 있으면, 저장소가 아닌 게 아니라 git 이
      # 거부한 것이다(safe.directory 소유권 거부·권한·손상). 그대로 두면 정본 저장소
      # 전체가 앵커 밖 파일에 대해 무게이트 + 무신호로 조용히 감시 축소된다.
      # 판정은 바꾸지 않는다(추측으로 게이트를 세우면 남의 저장소를 오탐한다) — 알리기만
      # 한다. physical_path 가 fail-loud 인데 여기만 fail-silent 이던 비대칭을 없앤다.
      [ -z "$root" ] && has_git_ancestor "$abs" && JUDGE_MSG="$MSG_GIT_UNAVAILABLE"
    fi
  fi
  return 0
}

# judge_file <편집 경로> — 그 파일 하나를 판정해 플래그를 세운다. Edit 경로와 Bash 스윕이
# **같은 함수**를 부른다. 알릴 것이 있으면 JUDGE_MSG 에 담는다(출력하지 않는다).
judge_file() {
  local file_path="$1" abs lower_abs dual_value dw flag write_failed
  local design=0 dok
  JUDGE_MSG=""
  # 개행 가드는 **정규화보다 먼저**여야 한다. 디렉토리 컴포넌트가 개행으로 끝나면
  # (…/sr<LF>/app.ts) physical_path 의 pwd -P 출력을 받는 명령 치환이 그 개행을 먹어
  # 경로가 …/sr/app.ts 로 조용히 바뀐다 — 없는 파일이 게이트에 박히고 정작 편집한
  # 파일은 무게이트가 된다. 플래그 파일은 줄 단위라 개행이 든 경로는 애초에 못 적는다.
  case "$file_path" in
    *$'\n'*) JUDGE_MSG="$MSG_NEWLINE"; return 0 ;;
  esac

  # 양쪽을 물리 경로로 맞춘 뒤에 비교한다. git 은 실제 경로를 돌려주는데 편집 경로는
  # 심링크를 지나올 수 있고(macOS /var → /private/var), .. 로 되돌아올 수도 있다.
  # 정규화 없이 자르면 접두사가 안 맞아 프로젝트 안 편집이 통째로 "밖"으로 샌다.
  # PROJECT_DIR 은 디렉토리라 통째로 물리화한다(심링크 PROJECT_DIR — 케이스 11·12).
  # 편집 경로는 파일이라 마지막 성분 이름을 보존하는 physical_path 를 쓴다 — 두 계약이
  # 다르므로 함수도 둘이다. (proj 는 Bash 스윕도 쓰므로 진입부에서 **먼저** 구해 뒀다.)
  # 상대 편집 경로는 **입력 cwd** 기준이다 — 세션 루트는 고정이라 cwd=M 에서 `src/a.ts` 를
  # 고친 W 세션이 W 의 파일로 오인하면 안 된다([cx] r1). cwd 가 없으면 지금처럼 루트 기준.
  # 스윕은 언제나 절대경로를 넘기므로 이 분기를 타지 않는다.
  case "$file_path" in
    /*) ;;
    *)
      case "$HARNESS_CWD" in
        /*) file_path="$HARNESS_CWD/$file_path" ;;
        *) file_path="$proj/$file_path" ;;
      esac ;;
  esac
  abs="$(physical_path "$file_path")"

  # 설계·계획 산출물은 위치·git 여부와 무관하게 듀얼리뷰 게이트만 세운다.
  # **정규화 뒤**에 판정해야 한다: 상대경로 입력에는 선행 슬래시가 없어 아래 글롭에
  # 걸리지 않고, .. 가 섞인 경로는 기록값이 .claude/../_workspace/… 로 남는다.
  # 매칭만 소문자화하고 기록은 원본 대소문자로 한다.
  lower_abs="$(printf '%s' "$abs" | tr '[:upper:]' '[:lower:]')"
  # 설계·계획 산출물은 듀얼리뷰 **와 지식·머리 표명 게이트**를 세운다. 코드가 아니므로
  # 타입체크·변경설명·감사는 과하지만, 설계가 나온 턴을 지식 저장소 반영 없이 끝내면
  # "왜 그렇게 정했나"가 그 자리에서 사라진다 — 결정을 만든 근거가 정확히 이 파일들이다.
  # 회수 플래그(ADR-0013·0015)는 머리 두 줄(`사전 결정 회수:`·`레퍼런스 조사:`) 표명을
  # Stop 이 검사하고 지키면 스스로 지운다. 이름에 codex 가 든다고 빼는 식의 **이름 제외는 두지 않는다** —
  # 관측되지 않은 재귀를 막으려고 실재하는 위음성(codex 를 다루는 정상 설계서의 무게이트)을
  # 만들게 된다. 리뷰 산출물과의 재귀는 명명 계약(리뷰 산출물은 NN_design·NN_plan 앵커
  # 금지 — 오케스트레이터 스킬)이 막는다.
  # [0-9][0-9]_ 앵커(2026-08-17 감사): 조사 산출물이 00_·01_ 번호를 선점하면 계획서가 02_plan_… 이
  # 되어 01_plan* 만 보던 글롭을 조용히 우회한다(POK-79 실측 — 게이트 미발동). 숫자 두 자리
  # 바로 뒤에 _design/_plan 을 요구하므로 NN_codex_plan_review 류 리뷰 파일(출처 토큰이 번호
  # 뒤에 옴)은 걸리지 않는다. 0?_ 로 쓰면 안 된다 — 글롭 ? 는 숫자가 아니라 **아무 문자
  # 한 개**라 0a_plan 이 오탐되고 10_plan 이 위음성으로 샌다([cx] 2026-08-17, 케이스 78·79).
  case "$lower_abs" in
    */_workspace/[0-9][0-9]_design*.md|*/_workspace/[0-9][0-9]_plan*.md)
      design=1 ;;
  esac
  # 추가 관할 폴더: 슬롯 안·세션 루트 밖의 설계 모양은 _workspace_<이름>/ 아래도 같은
  # 3종이다(쌍 형제 작업 공간 — 저장소 밖에 둔 트랙 설계서).
  if [ "$design" -eq 0 ] && [ "$EXTRA_ON" -eq 1 ] \
      && is_slot_entry "$abs" "$proj" && is_design_shaped "$abs"; then
    design=1
  fi
  if [ "$design" -eq 1 ]; then
    # 기록값 규칙은 verdict_of 와 같다 — 다른 체크아웃(세션 루트 아래 중첩 워크트리 포함)은 절대경로.
    dual_value="$abs"
    other_checkout "$abs" || dual_value="$(project_rel "$abs")" || dual_value="$abs"
    review_record_begin "$dual_value"
    dw=0
    dok=1
    record_flag "$DUALREVIEW_FLAG" "$dual_value" || { dw=1; dok=0; }
    record_flag "$KNOWLEDGE_FLAG"  "$dual_value" || dw=1
    record_flag "$RETRIEVAL_FLAG"  "$dual_value" || dw=1
    [ "$dw" -eq 1 ] && JUDGE_MSG="$MSG_WRITE_FAIL"
    review_record_end "$dual_value" "$dok" 1
    return 0
  fi

  verdict_of "$abs"

  # 결정 문서는 지식 게이트 하나만. 코드가 아니므로 타입체크·변경설명·감사는 과하다.
  if [ "$VERDICT" = 'knowledge' ]; then
    record_flag "$KNOWLEDGE_FLAG" "$VALUE" || JUDGE_MSG="$MSG_WRITE_FAIL"
    return 0
  fi

  [ "$VERDICT" = 'gate' ] || return 0

  # 완료 게이트 4종을 동시에 세운다:
  #   .needs-audit      → completion-auditor 강제 (Phase 6)
  #   .needs-explain    → change-explainer 강제 (Phase 5)
  #   .needs-knowledge  → 지식 저장소 반영 또는 불요 사유 기록 강제 (2026-08-02 kty —
  #                       산문 규칙이 기억에만 의존해 세션 내내 0회 이행된 실사고의 재발 방지)
  #   .needs-dualreview → codex 듀얼 리뷰 강제 (2026-08-03 kty)
  # 각 게이트는 해당 작업이 실제로 끝난 뒤에만 수동으로 지워진다. Stop 훅이 넷 다 본다.
  #
  # 지식 게이트가 꺼져 있어도 여기서는 **기록한다.** 켜짐/꺼짐 판정은 harness.env 를 한 번
  # 더 읽는 일인데 이 훅은 편집마다 돌고 Stop 훅은 턴에 한 번 돈다 — 판정은 Stop 쪽
  # 한 곳(knowledge_gate_active)으로 모았다. 꺼져 있으면 이 파일은 아무 효력이 없다.
  review_record_begin "$VALUE"
  write_failed=0
  dok=1
  for flag in "$AUDIT_FLAG" "$EXPLAIN_FLAG" "$KNOWLEDGE_FLAG" "$DUALREVIEW_FLAG"; do
    if ! record_flag "$flag" "$VALUE"; then
      write_failed=1
      [ "$flag" = "$DUALREVIEW_FLAG" ] && dok=0
    fi
  done
  # 넷이 다 실패해도 메시지는 한 줄만 낸다.
  [ "$write_failed" -eq 1 ] && JUDGE_MSG="$MSG_WRITE_FAIL"
  review_record_end "$VALUE" "$dok" 0
  return 0
}

# --- 리뷰 자리 기록 (수명 계약은 _extra_gate_dirs.sh 머리 주석) ----------------------
# 한 판정 안의 순서: ① review_record_begin(갱신 표시) → ② 기존 record_flag 들 →
# ③ review_record_end(현재 기록). 키가 없으면 아무것도 안 한다.

#######################################
# 결속 ① — 슬롯이 켜졌고 값이 절대경로면 갱신 표시 줄을 덧붙이고 RECORDING 을 켠다.
# 갱신 표시가 영구 실패(rc 2)면 그 값은 기록할 수 없다 — RECORD_PERMANENT 로 ③ 에 넘긴다.
# Globals:
#   EXTRA_ON (읽음) · RECORDING, RECORD_PERMANENT, RECORD_MSG (씀)
# Arguments:
#   $1 — 플래그 값
#######################################
review_record_begin() {
  local rc
  RECORDING=0
  RECORD_PERMANENT=0
  [ "$EXTRA_ON" -eq 1 ] || return 0
  case "$1" in /*) ;; *) return 0 ;; esac
  RECORDING=1
  record_review_pending "$1"
  rc=$?
  [ "$rc" -eq 2 ] && RECORD_PERMANENT=1
  note_record_rc "$rc"
}

#######################################
# 결속 ③ — 그 값의 현재 기록 줄을 덧붙인다. 자리 규칙: 슬롯 항목인 설계물 → 그
# 파일의 폴더 · 슬롯 항목이고 VERDICT_REPO 가 슬롯 안 → 그 저장소의 _workspace 와 형제
# _workspace_<이름> · 그 밖(git 밖 앵커, 최상위가 슬롯 밖, 슬롯 밖 절대 항목) → 빈 집합.
# 듀얼리뷰 플래그를 실제로 갱신하지 못했으면 쓰지 않고 회복 가능 문구를 낸다. 소속을
# 모르면(git 판독 실패) 빈 집합 대신 갱신 표시를 남긴다 — 둘 다 막는 쪽이다.
# Globals:
#   RECORDING, RECORD_PERMANENT, VERDICT_REPO, proj, DUALREVIEW_FLAG,
#   MSG_RECORD_GIT (읽음) · RECORD_MSG (씀)
# Arguments:
#   $1 — 플래그 값, $2 — 듀얼리뷰 플래그를 썼는가(1|0), $3 — 설계물인가(1|0)
#######################################
review_record_end() {
  local v="$1" sibling
  [ "$RECORDING" -eq 1 ] || return 0
  # 플래그의 실제 갱신을 확인한다 — record_flag 는 이미 있는 줄이면 touch 실패를 무시하고
  # 0 을 낸다(키 부재 동작 그대로). 그대로 믿으면 mtime 이 옛날인 채 현재 기록이 서서
  # 재편집 전 리뷰로 풀린다. 한 번 더 갱신해 rc 로 본다.
  if [ "$2" -ne 1 ] || ! touch "$DUALREVIEW_FLAG" 2>/dev/null; then
    note_record_rc 1
    return 0
  fi
  if ! is_slot_entry "$v" "$proj"; then
    record_review_dirs "$v"
  elif [ "$3" -eq 1 ]; then
    record_review_dirs "$v" "${v%/*}"
  elif [ -n "$VERDICT_REPO" ] && in_extra_gate_dir "$VERDICT_REPO" \
      && sibling="$(sibling_workspace_of "$VERDICT_REPO")"; then
    record_review_dirs "$v" "$VERDICT_REPO/_workspace" "$sibling"
  elif [ -z "$VERDICT_REPO" ] && has_git_ancestor "$v"; then
    # 소속을 모른다(.git 은 있는데 최상위를 못 받음) — 빈 집합이면 세션 루트 리뷰로 풀린다.
    # 현재 기록을 쓰지 않아 끝줄이 갱신 표시로 남고 턴 종료에서 막힌다 — 그 사실과 출구를
    # 알린다(일반 git 판독 실패 문구의 "앵커 밖 파일에는 게이트가 서지 않았다"는 이 값에 맞지
    # 않는다). 판정 알림(JUDGE_MSG)이 아니라 기록 알림으로 낸다 — Bash 스윕은 판정 알림을
    # 부분 기록 문구 하나로 접어 "게이트는 섰고 막힌다"를 숨긴다 — 같은 판정에 판정 알림
    # (다른 플래그 쓰기 실패)이 있어도 낸다. 갱신 표시부터 기록할 수 없었으면(영구) git 을
    # 고쳐 다시 저장해도 기록되지 않으니 영구 문구만 둔다. 현재 기록 줄만 1023바이트를 넘는
    # 값은 여기서 알 수 없다(자리를 모른다) — git 문구가 그 경우를 적는다.
    [ "$RECORD_PERMANENT" -eq 1 ] || add_record_msg "$MSG_RECORD_GIT"
    return 0
  else
    record_review_dirs "$v"
  fi
  note_record_rc $?
}

#######################################
# 기록 함수의 rc 를 RECORD_MSG 로 옮긴다. 회복 가능(쓰기 실패)과 영구(값에 US·LF)는
# 안내가 달라, 한 스윕에 둘 다 생기면 둘 다 싣는다(같은 문구는 한 번).
# Globals:
#   MSG_RECORD_FAIL, MSG_RECORD_PERMANENT (읽음) · RECORD_MSG (씀)
# Arguments:
#   $1 — record_review_pending · record_review_dirs 의 rc
#######################################
note_record_rc() {
  case "$1" in
    0) return 0 ;;
    2) add_record_msg "$MSG_RECORD_PERMANENT" ;;
    *) add_record_msg "$MSG_RECORD_FAIL" ;;
  esac
}

#######################################
# 리뷰 자리 기록 알림 하나를 RECORD_MSG 에 덧붙인다(같은 문구는 한 번).
# Globals:
#   RECORD_MSG (씀)
# Arguments:
#   $1 — 문구
#######################################
add_record_msg() {
  case "$RECORD_MSG" in
    *"$1"*) ;;
    *) RECORD_MSG="${RECORD_MSG:+$RECORD_MSG }$1" ;;
  esac
}

# --- 진입 -----------------------------------------------------------------

payload="$(cat)"
bind_session_state "$(printf '%s' "$payload" | json_get session_id)"
# 세션 루트(_common.sh). 그 세션의 첫 호출이면 여기서 고정되고, 이후로는 cwd 와 무관하다.
bind_project_dir "$(printf '%s' "$payload" | json_get cwd)"
WINDOW_DIR="$SESSION_STATE_DIR/.bash-windows"
# json_get 결과를 **센티널로** 받는다. 명령 치환은 후행 개행을 전부 지우므로 그냥 받으면
# 경로 끝의 개행이 아래 가드에 닿기도 전에 사라지고, 경고 없이 **다른 파일** 경로가
# 기록된다("src/app.ts" + LF → "src/app.ts"). X 를 붙여 받고 도로 뗀 뒤, json_get 자신이
# print() 로 붙인 개행 **하나만** 지운다 — 그러면 원본의 후행 개행이 살아남는다.
raw="$(printf '%s' "$payload" | json_get tool_input.file_path; printf 'X')"
raw="${raw%X}"
file_path="${raw%$'\n'}"

# proj 는 두 갈래가 다 쓴다(스윕의 기본 뿌리 · judge_file 의 상대경로 해석). 분기 전에 구한다.
proj="$(physical_dir "$PROJECT_DIR")"

# 추가 관할 폴더 슬롯. 분기 전에 정한다 — 어느 출구로 나가든 그 알림을 실어야 한다.
extra_gate_setup

# file_path 가 없으면 Bash 다. 명령이 무엇을 썼는지는 **결과로** 알아낸다(위 스윕 주석).
if [ -z "$file_path" ]; then
  cmd_raw="$(printf '%s' "$payload" | json_get tool_input.command; printf 'X')"
  cmd_raw="${cmd_raw%X}"
  [ -n "${cmd_raw%$'\n'}" ] || finish_hook ""
  sweep_bash_writes "${cmd_raw%$'\n'}"
  finish_hook "$SWEEP_MSG"
fi

judge_file "$file_path"
finish_hook "$JUDGE_MSG"
