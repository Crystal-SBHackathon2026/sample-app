#!/usr/bin/env bash
# PreToolUse(Bash): "이 Bash 명령이 시작한 시각" 표식을 **호출마다 하나씩** 찍는다.
#
# mark-needs-audit 의 Bash 스윕이 이 표식보다 새로 바뀐 파일을 찾아 게이트를 세운다.
#
# **왜 파일 하나가 아니라 디렉토리인가 (codex r1 CRITICAL):** 표식이 하나뿐이면 병렬 Bash
# 호출이 서로를 지운다. A가 파일을 쓴 뒤 B의 PreToolUse 가 표식을 덮으면, A의 PostToolUse
# 도 새 표식 기준으로만 찾아 **A의 변경이 통째로 사라진다.** Claude Code 는 독립 도구 호출을
# 병렬로 돌리므로 가정이 아니라 상시 조건이다.
#
# 그래서 호출마다 창을 하나 만들고, PostToolUse 는 **가장 오래된 창**을 소비한다. 짝이
# 정확히 맞지는 않지만 항상 **더 넓은 창**을 쓰므로 놓치는 파일이 없다 — 게이트에서
# 과탐(다른 호출이 쓴 파일까지 잡음)은 싸고 누락은 비싸다.
#
# PreToolUse 지만 **절대 차단하지 않는다.** 표식을 못 찍어도 도구는 돌아야 한다.
# stdout 에 아무것도 쓰지 않는다(PreToolUse 의 stdout 은 도구 동작을 바꿀 수 있다).
#
# 셸 이식성: macOS 기본 bash 는 3.2 다. ${var,,}·mapfile·연관배열 금지.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

HOOK_ID="pre:bash:window"
hook_disabled "$HOOK_ID" && exit 0

# 페이로드는 반드시 끝까지 읽는다 — 읽지 않으면 파이프가 막힐 수 있다. 세션 번호만 쓴다:
# 창이 세션마다 따로여야 다른 세션의 PostToolUse 가 이 창을 소비하지 않는다(2026-10-01 실사고).
payload="$(cat 2>/dev/null)"
bind_session_state "$(printf '%s' "$payload" | json_get session_id)"
# 세션의 첫 훅 호출이 이것일 수 있다 — 세션 루트(.root)를 여기서도 고정한다(_common.sh).
bind_project_dir "$(printf '%s' "$payload" | json_get cwd)"

WINDOW_DIR="$SESSION_STATE_DIR/.bash-windows"
mkdir -p "$WINDOW_DIR" 2>/dev/null || exit 0

# 짝이 안 맞아 남은 창을 치운다(도구가 차단돼 PostToolUse 가 안 돈 경우). 1시간이면
# 그 창으로 스윕해 봐야 의미가 없고, 쌓이면 가장 오래된 창이 영영 넓어진다.
find "$WINDOW_DIR" -type f -mmin +60 -delete 2>/dev/null

: > "$WINDOW_DIR/$$.$RANDOM" 2>/dev/null || true

exit 0
