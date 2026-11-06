#!/usr/bin/env bash
# Stop: 코드를 건드린 턴은 (1) 타입체크 통과 (2) change-explainer 실행
#       (3) completion-auditor 실행 없이는 끝낼 수 없다.
#
# 무한루프 가드: "같은 지점에서 진전 없이" MAX_BLOCKS(3)회까지만 막는다.
# 게이트를 하나 지울 때마다(차단 지문 변화) 카운터가 리셋되므로 순차 처리로는
# 소진되지 않는다. 소진되면 플래그를 지우고 통과시키되 사용자에게 큰 경고를
# 띄운다. 세션이 벽돌이 되는 것보다 낫다. 지문 파일을 못 쓰면 리셋 없는 구식
# 누적으로, 카운터 파일도 못 쓰면 stop_hook_active 로 폴백한다.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

HOOK_ID="stop:verify"
hook_disabled "$HOOK_ID" && exit 0

payload="$(cat)"
bind_session_state "$(printf '%s' "$payload" | json_get session_id)"
# 세션 루트(_common.sh). 워크트리 세션이면 아래 검증(타입체크·스타일·push·리뷰 산출물·머리
# 표명)이 전부 그 세션에 고정된 루트 하나에서 돈다 — 지금 cwd 와 무관하다.
bind_project_dir "$(printf '%s' "$payload" | json_get cwd)"
stop_active="$(printf '%s' "$payload" | json_get stop_hook_active)"
# 대화 기록 경로. 결정 게이트(3.2)가 이 턴의 발화를 읽는 데 쓴다. 비어 있거나 못 읽으면
# 그 게이트만 생략되고 **사유가 마지막 게이트 메시지에 실린다** — 조용히 사라지지 않는
# 것이 이 fail-open 의 조건이다(decision_scan 주석 참조).
transcript_path="$(printf '%s' "$payload" | json_get transcript_path)"

# (0) push 미완 **탐지** — 조기 종료보다 **먼저** 해야 한다.
#     플래그를 다 처리해 지운 뒤가 바로 위험한 시점인데(29커밋을 잃은 그 상태),
#     아래 조기 종료가 먼저 걸리면 push 게이트는 영영 안 돈다(검수 [치명] 지적).
#     탐지만 여기서 하고 차단은 예산·지문 기계가 준비된 뒤에 한다.
push_unsent=""
push_branch=""
if ! hook_disabled "stop:push" && git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  push_branch="$(git -C "$PROJECT_DIR" symbolic-ref --short HEAD 2>/dev/null)"
  if [ -n "$push_branch" ] && git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1; then
    if git -C "$PROJECT_DIR" rev-parse --verify -q "refs/remotes/origin/$push_branch" >/dev/null 2>&1; then
      # rc 를 따로 본다. 실패를 "ahead 0" 으로 읽으면 게이트가 조용히 사라진다([cx] 지적).
      if push_n="$(git -C "$PROJECT_DIR" rev-list --count "refs/remotes/origin/$push_branch..HEAD" 2>/dev/null)"; then
        [ -n "$push_n" ] && [ "$push_n" != "0" ] && push_unsent="원격보다 ${push_n}개 앞서 있습니다"
      else
        push_unsent="원격과의 차이를 셀 수 없습니다(저장소 상태 이상) — 직접 확인하세요"
      fi
    elif git -C "$PROJECT_DIR" rev-parse --verify -q HEAD >/dev/null 2>&1; then
      # ref 가 없다. 다만 **HEAD 가 이미 다른 원격 브랜치에 있으면** 새 커밋이 없는
      # 갓 만든 브랜치이므로 요구하지 않는다 — 안 그러면 브랜치를 파자마자 막힌다.
      # 파이프 안 서브셸에서 exit 로 신호하면 그 rc 가 밖으로 안 나온다 — 실제로 그렇게
      # 짰다가 조건이 항상 거짓이 됐다. 서브셸 없는 for 루프로 판정한다(ref 이름에는
      # 공백이 못 들어가므로 단어 분리가 안전하다).
      head_on_remote=0
      for _r in $(git -C "$PROJECT_DIR" for-each-ref --format='%(refname)' refs/remotes 2>/dev/null); do
        if git -C "$PROJECT_DIR" merge-base --is-ancestor HEAD "$_r" 2>/dev/null; then
          head_on_remote=1; break
        fi
      done
      if [ "$head_on_remote" -eq 0 ]; then
        push_unsent="이 브랜치의 원격 추적 ref 가 없습니다 (한 번도 push 되지 않았거나, refspec 이 좁혀져 보이지 않습니다)"
      fi
    fi
  fi
fi

# "남은 할 일" 판정을 **한 곳에 모은 술어.** 조기 종료(1)와 회수 게이트(3.4)의 자동 해제
# 후 재평가가 같은 술어를 쓴다 — 두 자리가 따로 열거하면 언젠가 어긋나고, push 는
# 플래그가 아니라 (0)의 계산값이라 열거 누락이 가장 나기 쉽다. 실제로 설계 검수에서
# "재평가가 플래그만 세면 자동 해제가 push 게이트를 우회한다"([cc·cx])가 잡혔다 —
# 커밋 29개를 잃은 그 상태가 새 게이트로 다시 열리는 경로였다.
# 지식·회수 플래그는 **게이트가 살아 있을 때만** 할 일로 센다 — 껐는데 예전에 남은
# 플래그 파일이 읽기 전용 턴의 조기 종료를 막으면 안 된다.
work_pending() {
  [ -n "$push_unsent" ] && return 0
  [ -s "$AUDIT_FLAG" ] && return 0
  [ -s "$EXPLAIN_FLAG" ] && return 0
  knowledge_gate_active && return 0
  [ -s "$DUALREVIEW_FLAG" ] && return 0
  retrieval_pending && return 0
  return 1
}

# (1) 코드 변경이 없는 턴 → 검사 전부 생략. 읽기 전용 질문에 타입체크를 돌리지 않는다.
if ! work_pending; then
  rm -f "$BLOCK_COUNT" "$BLOCK_FP" 2>/dev/null
  exit 0
fi

# (2) 카운터 확인 — 벽돌 방지, 진전 인지 리셋 (2026-08-03 [cx] 지적 반영)
# 카운터의 목적은 "갇힘 감지"이지 노력 예산이 아니다. 게이트가 4종으로 늘며 공유 카운터
# 3회로는 게이트를 순서대로 성실히 처리해도 마지막 감사 게이트 전에 소진되는 역설이 있었다.
# → 차단 지문(어느 게이트에서, 어떤 플래그 상태로 막혔나)이 지난 차단과 다르면 = 진전이면
#   카운터를 리셋한다. 같은 지문으로 MAX_BLOCKS회 = 진짜 갇힘일 때만 경고와 통과.
count=0
if [ -f "$BLOCK_COUNT" ]; then
  count="$(tr -dc '0-9' < "$BLOCK_COUNT" 2>/dev/null)"
fi
[ -z "$count" ] && count=0
prev_fp="$(cat "$BLOCK_FP" 2>/dev/null)"
# 지문 = 서 있는 플래그의 집합(내용 아님). 내용을 넣으면 갇힌 채 새 파일만 편집해도
# 리셋되고(무한 차단), cksum 충돌로 실제 진전이 리셋 안 될 수도 있다([cx] 지적).
#
# **함수인 이유:** 3.4 게이트가 실행 도중 자기 플래그를 지운다(자동 해제). 진입 시 1회
# 스냅숏만 쓰면 그 턴의 하위 게이트(3.5~6)가 이미 지워진 "r" 비트가 든 stale 지문으로
# 예산을 매기고, 다음 턴의 지문과 달라져 **진전이 아닌데 카운터가 리셋**된다 — 벽돌
# 방지가 한 사이클 헛돈다(구현 검수 [cc]가 4회 연속 실행으로 재현: 1/3→1/3→2/3→3/3).
compute_flags_fp() {
  flags_fp=""
  [ -s "$AUDIT_FLAG" ]      && flags_fp="${flags_fp}a"
  [ -s "$EXPLAIN_FLAG" ]    && flags_fp="${flags_fp}e"
  knowledge_gate_active     && flags_fp="${flags_fp}k"
  [ -s "$DUALREVIEW_FLAG" ] && flags_fp="${flags_fp}d"
  # 회수 플래그도 **존재 비트만** 넣는다. 불량 파일 목록은 retrieval 게이트 자신의 예산
  # 키에만 결합한다(아래 3.4) — 여기(공유 지문)에 넣으면 결정 게이트에 갇힌 채 불량 집합만
  # 바뀌어도 그쪽 예산이 리셋돼, 위 "내용을 넣으면"의 경고 그대로가 된다([cc·cx] 검수).
  retrieval_pending         && flags_fp="${flags_fp}r"
  # push 는 "몇 개 남았나"가 곧 진전이다. 지문에 안 넣으면 한 커밋씩 올리는 실제 진전이
  # 같은 지문으로 세어져 예산이 소진되고, 그때 감사 플래그까지 함께 지워진다([cx] 지적).
  [ -n "$push_unsent" ] && flags_fp="${flags_fp}p:${push_branch}:${push_unsent}"
}
flags_fp=""
compute_flags_fp
new_fp=""

gate_budget() {  # $1 = 게이트 식별자. 각 차단 지점이 메시지 출력 전에 호출한다.
  new_fp="$1|$flags_fp"
  # 지문을 기록할 수 있을 때만 리셋한다 — 지문 파일을 못 쓰는 환경에서 리셋하면
  # prev_fp가 영원히 비어 매번 1/3로 무한 차단된다([cx] 지적). 그 경우 리셋 없는
  # 구식 누적으로 동작해 3회 후 통과가 보장된다.
  if printf '%s\n' "$new_fp" > "$BLOCK_FP" 2>/dev/null; then
    if [ "$new_fp" != "$prev_fp" ]; then
      count=0   # 지난 차단과 다른 게이트/플래그 집합 = 진전 — 예산 리셋
    fi
  fi
  if [ "$count" -ge "$MAX_BLOCKS" ]; then
    changed="$(cat "$AUDIT_FLAG" "$EXPLAIN_FLAG" "$KNOWLEDGE_FLAG" "$DUALREVIEW_FLAG" "$RETRIEVAL_FLAG" 2>/dev/null | tr -d '"\\' | sort -u | tr '\n' ' ')"
    rm -f "$AUDIT_FLAG" "$EXPLAIN_FLAG" "$KNOWLEDGE_FLAG" "$DUALREVIEW_FLAG" "$RETRIEVAL_FLAG" "$BLOCK_COUNT" "$BLOCK_FP" 2>/dev/null
    # 판독 불가 사유도 함께 싣는다. 여기서 빠뜨리면 **예산이 소진된 턴에 발생한**
    # 판독 불가가 영구 소실된다 — 게이트 메시지가 이 경로로는 안 나가기 때문이다([cx] 2라운드).
    printf '{"systemMessage":"[완료 게이트] 같은 지점(%s)에서 %s회 차단 후에도 진전이 없어 세션 벽돌 방지를 위해 통과시킵니다. 이 턴의 완료 주장(및 변경 설명)을 신뢰하지 마세요. 미처리 변경: %s%s"}\n' \
      "$1" "$MAX_BLOCKS" "$changed" \
      "${decision_note:+ / $decision_note}"
    exit 0
  fi
}

# 결정 게이트가 대화 기록을 못 읽었으면 **어느 게이트가 막든** 그 사유를 함께 낸다.
# 감사 게이트에만 실으면, 앞 게이트가 먼저 막은 턴에는 안 보이고 그 플래그를 지운 다음
# 턴에는 조기 종료로 **영영 사라진다**(검수 [cx] 지적). 조용히 사라지는 것이 이 게이트를
# 만든 이유 그 자체라, 경고를 삼키지 않는 것이 fail-open 의 조건이다.
emit_decision_note() {
  [ -n "${decision_note:-}" ] || return 0
  echo
  echo "참고: $decision_note"
  echo "      → 이 턴에 사용자에게 물었어야 할 결정이 없었는지 스스로 확인하세요."
}

bump_and_block() {
  if ! printf '%s\n' "$((count + 1))" > "$BLOCK_COUNT" 2>/dev/null; then
    # 카운터를 못 쓰면 무한루프 위험 → 표준 가드로 폴백
    case "$stop_active" in
      [Tt]rue) exit 0 ;;
    esac
  fi
  exit 2
}

# 검증 명령 하나를 PROJECT_DIR 에서 돌린다. 결과는 gc_out(합친 출력)·gc_rc(종료 코드).
# 타입체크와 스타일 검사가 **같은 실행 규약**을 쓰게 하려고 함수로 둔다 — 두 자리가
# 따로 timeout 을 찾고 따로 sh -c 를 부르면 언젠가 한쪽만 고쳐진다.
#
# **개별 상한이 합쳐서 훅 상한을 넘으면 안 된다 (codex r1 CRITICAL).** 예전엔 명령마다
# 90초였는데 명령이 둘이 되면서 최악 180초가 됐고, settings.json 의 훅 상한(이제 180)을
# 넘으면 Claude Code 가 훅을 취소한다 — 그러면 **출력도 판정도 없이** 나머지 게이트가
# 통째로 사라진다(fail-open). 그래서 명령당 상한을 아래 값으로 낮추고 훅 상한을 올렸다:
#   명령당 GATE_CMD_TIMEOUT(45) × 2 + 나머지 게이트 여유 < settings.json 의 180
# macOS 기본에는 timeout 이 없다. 그 경우 훅 상한만 남으므로 여유가 더 중요하다.
# HARNESS_CHECK_ROOT 로 검사 대상 루트를 늘 알린다 — 다른 체크아웃에 있는 번들 스타일 검사기가
# 자기 위치가 아니라 이 루트를 보게 한다(아래 3.1). 상속된 값은 여기서 덮어쓴다.
GATE_CMD_TIMEOUT=45
gc_out=""
gc_rc=0
run_gate_command() {
  local cmd="$1" bin=""
  if command -v timeout >/dev/null 2>&1; then
    bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    bin="gtimeout"
  fi
  if [ -n "$bin" ]; then
    gc_out="$(cd "$PROJECT_DIR" && HARNESS_CHECK_ROOT="$PROJECT_DIR" \
      "$bin" "$GATE_CMD_TIMEOUT" sh -c "$cmd" 2>&1)"; gc_rc=$?
  else
    gc_out="$(cd "$PROJECT_DIR" && HARNESS_CHECK_ROOT="$PROJECT_DIR" sh -c "$cmd" 2>&1)"; gc_rc=$?
  fi
}

# (3) 타입체크 — 결정론적 바닥. 명령은 프로필에서 파생된 harness.env 에서 읽는다.
#     HARNESS_TYPECHECK_CMD 가 비어 있으면(타입 없는 언어/미설정) 생략한다.
#     이렇게 하면 이 훅이 특정 스택(pnpm/tsc)에 묶이지 않는다 — 도메인-무관 재사용.
#     **이 파일을 실행하지 않는다.** source 하면 사용자 소유 셸 파일이 훅의 제어 흐름을
#     가져간다 — `exit 0` 한 줄이면 이 훅이 조용히 끝나 **게이트 4종이 통째로 사라지고**
#     흔적도 안 남는다. 원문 판독으로 그 부류를 없앤다(harness_env_value 주석 참조).
typecheck_note=""
#     rc 를 함께 받는다. "리터럴로 비웠다"(rc=0 + 빈 값 = 의도한 생략) · "부재"(rc=3 =
#     키를 안 씀) · "값을 믿을 수 없다"(rc=1 = 선언 2개 이상·지원 문법 밖·읽기 실패)는
#     셋 다 생략으로 가지만 사용자에게 **다른 정보**다 — 마지막 것만 고칠 수 있는 실수라
#     그렇게 적어야 한다(구분의 정본은 _common.sh 반환 계약 — ADR-0016).
TYPECHECK_CMD="$(harness_env_value HARNESS_TYPECHECK_CMD)"; typecheck_rc=$?

if [ "$typecheck_rc" -eq 3 ]; then
  typecheck_note="타입체크 생략 (HARNESS_TYPECHECK_CMD 미설정)"
elif [ "$typecheck_rc" -ne 0 ]; then
  typecheck_note="타입체크 생략 (harness.env 의 HARNESS_TYPECHECK_CMD 값을 믿을 수 없음 — 선언이 2개 이상이거나, 지원 문법 밖이거나, 읽기 실패입니다. 고칠 수 있는 실수입니다)"
elif [ -z "$TYPECHECK_CMD" ]; then
  typecheck_note="타입체크 생략 (HARNESS_TYPECHECK_CMD 가 빈 값으로 설정됨)"
else
  run_gate_command "$TYPECHECK_CMD"
  tc_out="$gc_out"; tc_rc="$gc_rc"

  if [ "$tc_rc" -eq 124 ] || [ "$tc_rc" -eq 137 ]; then
    # 타임아웃은 "타입 오류"가 아니라 "모름". 차단하지 않고 감사자에게 넘긴다.
    typecheck_note="타입체크 타임아웃 → 생략 (감사자가 재확인할 것)"
  elif [ "$tc_rc" -eq 127 ]; then
    # 명령/도구 없음(rc=127)은 "타입 오류"가 아니다. 오탐 차단 방지 위해 생략.
    typecheck_note="타입체크 생략 (명령 실행 불가 rc=127): $TYPECHECK_CMD"
  elif [ "$tc_rc" -ne 0 ]; then
    gate_budget "typecheck"
    {
      echo "[완료 차단] 타입체크 실패 — 지금은 '완료'가 아닙니다."
      echo
      echo "명령: $TYPECHECK_CMD"
      echo
      printf '%s\n' "$tc_out" | head -n 15
      echo
      echo "고친 뒤 다시 종료하세요.  (차단 $((count + 1))/${MAX_BLOCKS})"
      echo "탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=$HOOK_ID"
    } >&2
    bump_and_block
  fi
fi

# (3.1) 스타일 검사 — Google 스타일 가이드의 **기계로 판정 가능한** 조항
#      (principles.md '스타일 정본' 절, ADR-0023).
#
#      **왜 타입체크와 슬롯을 나누나:** 처음에는 HARNESS_TYPECHECK_CMD 에 이어 붙이게 했는데,
#      프로젝트가 자기 타입체크를 넣으면서 값을 통째로 갈아치우면 스타일 게이트가 조용히
#      사라졌다. 기계가 못 막고 주석이 부탁할 뿐인 게이트는 게이트가 아니다. 슬롯을 나누면
#      한쪽을 덮어써도 다른 쪽이 산다.
#
#      **키가 없으면 켜진다.** 이 키를 모르는 기존 설치본에서 게이트가 조용히 꺼지면 안 된다
#      (HARNESS_KNOWLEDGE_GATE 와 같은 원리 — 표명이 없으면 안전한 쪽을 고른다). 키가 없을
#      때는 번들된 검사기를 찾아 돌리고, 그것도 없으면 생략한다.
#      끄려면 **값을 비운다** — 그 방법 하나뿐이다.
#
#      **번들 검사기가 세션 루트에 없으면 원래 루트의 것을 쓴다**([cx] r1 #4). 하네스가 메인
#      체크아웃에만 설치된 워크트리에는 검사기가 없어서, 상대경로를 워크트리에서 돌리면 rc=127 로
#      검사가 조용히 생략됐다. 명령 안의 상대경로를 원래 루트의 절대경로로 바꾸되 **홑따옴표로
#      인용**한다 — 경로에 공백이 있어도 sh -c 가 한 인자로 읽는다. 검사 대상은 여전히 세션
#      루트다(run_gate_command 의 HARNESS_CHECK_ROOT). 기본 형태가 아닌 명령(따옴표·절대경로)은
#      그대로 돈다 — 따옴표 친 상대경로는 세션 루트에 검사기가 없으면 rc=127 생략 사유로 남는다.
stylecheck_note=""
STYLECHECK_CMD="$(harness_env_value HARNESS_STYLECHECK_CMD)"; stylecheck_rc=$?
BUNDLED_STYLECHECK=".claude/skills/google-styleguide/scripts/check-style.sh"
style_fallback=""
if [ ! -f "$PROJECT_DIR/$BUNDLED_STYLECHECK" ] && [ -f "$ORIG_ROOT/$BUNDLED_STYLECHECK" ]; then
  style_fallback="'$(printf '%s' "$ORIG_ROOT/$BUNDLED_STYLECHECK" | sed "s/'/'\\\\''/g")'"
fi
# 바꾸는 것은 **기본 형태**(따옴표 없는 상대경로 `bash <번들 경로>` 로 시작)뿐이다. 따옴표를 쳤거나
# 절대경로인 명령은 손대지 않고 그대로 돌린다 — 부분 문자열을 치환하면 그런 명령이 깨진다([cx] r1).
if [ -n "$style_fallback" ] && [ "$stylecheck_rc" -eq 0 ]; then
  case "$STYLECHECK_CMD" in
    "bash $BUNDLED_STYLECHECK" | "bash $BUNDLED_STYLECHECK "*)
      STYLECHECK_CMD="bash $style_fallback${STYLECHECK_CMD#"bash $BUNDLED_STYLECHECK"}" ;;
  esac
fi

if [ "$stylecheck_rc" -eq 3 ]; then
  # 키 부재 — 번들 검사기로 축퇴한다(있으면).
  if [ -f "$PROJECT_DIR/$BUNDLED_STYLECHECK" ]; then
    STYLECHECK_CMD="bash $BUNDLED_STYLECHECK"
    stylecheck_rc=0
  elif [ -n "$style_fallback" ]; then
    STYLECHECK_CMD="bash $style_fallback"
    stylecheck_rc=0
  else
    stylecheck_note="스타일 검사 생략 (HARNESS_STYLECHECK_CMD 미설정, 번들 검사기도 없음)"
    STYLECHECK_CMD=""
  fi
fi

if [ -n "$stylecheck_note" ]; then
  : # 위에서 이미 사유를 적었다
elif [ "$stylecheck_rc" -ne 0 ]; then
  stylecheck_note="스타일 검사 생략 (harness.env 의 HARNESS_STYLECHECK_CMD 값을 믿을 수 없음 — 선언이 2개 이상이거나, 지원 문법 밖이거나, 읽기 실패입니다. 고칠 수 있는 실수입니다)"
elif [ -z "$STYLECHECK_CMD" ]; then
  stylecheck_note="스타일 검사 생략 (HARNESS_STYLECHECK_CMD 가 빈 값으로 설정됨)"
elif ! hook_disabled "stop:stylecheck"; then
  run_gate_command "$STYLECHECK_CMD"
  sc_out="$gc_out"; sc_rc="$gc_rc"

  if [ "$sc_rc" -eq 124 ] || [ "$sc_rc" -eq 137 ]; then
    stylecheck_note="스타일 검사 타임아웃 → 생략 (감사자가 재확인할 것)"
  elif [ "$sc_rc" -eq 127 ]; then
    # 도구 부재(gofmt 없음 등)는 "위반"이 아니다. 오탐 차단을 만들지 않는다.
    stylecheck_note="스타일 검사 생략 (명령 실행 불가 rc=127): $STYLECHECK_CMD"
  elif [ "$sc_rc" -ne 0 ]; then
    gate_budget "stylecheck"
    {
      echo "[완료 차단] 스타일 검사 실패 — 지금은 '완료'가 아닙니다."
      echo
      echo "Google 스타일 가이드의 기계 판정 조항을 어겼습니다 (principles.md '스타일 정본' 절)."
      echo "명령: $STYLECHECK_CMD"
      echo
      printf '%s\n' "$sc_out" | head -n 15
      echo
      echo "고친 뒤 다시 종료하세요.  (차단 $((count + 1))/${MAX_BLOCKS})"
      echo "탈출구는 타입체크 게이트와 같습니다 (위 메시지 참조). 훅 식별자는 stop:stylecheck 입니다."
    } >&2
    bump_and_block
  fi
fi

# (3.2) **결정 게이트** — "물어봤어야 할 것을 혼자 정했나".
#      나머지 게이트가 전부 **산출물**을 볼 때 이것만 **에이전트 자신의 행동**을 본다.
#      판정 규칙·좁히는 장치 셋·fail-open 사유는 _common.sh 의 decision_scan 주석이 정본이다.
#
#      **타입체크 다음, 나머지 게이트보다 앞에 둔다.** 질문의 답이 코드를 바꿀 수 있으므로, 리뷰·설명·감사에
#      노력을 쓰기 전에 묻는 편이 싸다. (push 탐지와 달리 순서가 정확성을 바꾸지는 않는다 —
#      대화 기록은 이미 다 쓰였고 게이트 순서가 그 내용을 바꾸지 않기 때문이다.)
decision_note=""
# **발동 조건은 플래그다.** 조기 종료는 push 미완만으로도 풀리므로, 그것만 보고 스캔하면
# 아무것도 안 바꾼 읽기 전용 턴까지 검사하게 된다 — "플래그와 무관하게 항상"은 사용자가
# 기각한 보기다. 여기서 한 번 더 물어 발동 계약을 조기 종료와 분리한다.
decision_armed=0
if [ -s "$AUDIT_FLAG" ] || [ -s "$EXPLAIN_FLAG" ] || [ -s "$DUALREVIEW_FLAG" ] || knowledge_gate_active; then
  decision_armed=1
fi
if [ "$decision_armed" -eq 1 ] && ! hook_disabled "stop:decision"; then
  decision_hits="$(decision_scan "$transcript_path")"; decision_rc=$?
  case "$decision_rc" in
    3) : ;;   # 표지 없음 · 또는 이 턴에 물었음
    2)
      # **이 게이트의 유일한 fail-open.** 통과시키되 사유를 게이트 메시지에 실어 보낸다.
      # 대화 기록 형식은 하네스 소유가 아니라, 여기서 차단하면 그 세션 안에 고칠 방법이 없다.
      decision_note="결정 게이트 생략 ($decision_hits)" ;;
    0) ;;     # 아래에서 차단한다 (case 안에서 하면 들여쓰기가 깊어져 메시지가 안 읽힌다)
    *)
      # **모르는 rc 는 통과가 아니라 판독 불가다.** python3 부재(127)·처리 못 한 예외(1)·
      # 신호 종료가 전부 여기로 온다. 이걸 통과로 읽으면 게이트가 조용히 사라진다.
      decision_note="결정 게이트 생략 (스캐너가 예상 밖 상태로 끝남 rc=$decision_rc — python3 부재·예외·신호 종료일 수 있습니다)" ;;
  esac
  if [ "$decision_rc" -eq 0 ]; then
    gate_budget "decision"
    {
      echo "[완료 차단] 혼자 정한 것이 있는데 이 턴에 사용자에게 한 번도 묻지 않았습니다."
      echo
      echo "걸린 문장:"
      printf '%s\n' "$decision_hits" | sed 's/^/  - /'
      echo
      echo "이 게이트가 겨누는 것:"
      echo "  게이트가 막을 때는 따르면서, 게이트가 없는 자리에서는 혼자 정하고 보고서에"
      echo "  한 줄 적는 부류입니다. 그 '한 줄'은 도구 호출이 아니라 문장이라 승인창이"
      echo "  안 뜨고, 그래서 이 저장소가 겪은 실패 대부분이 이 축에서 났습니다."
      echo
      echo "해야 할 일:"
      echo "  1. 위 문장들이 정말 **사용자가 정할 일**이었는지 본다."
      echo "     '범위 밖'·'별도로'·'그대로 뒀'는 대개 선택지를 줬어야 하는 자리입니다."
      echo "  2. AskUserQuestion 으로 **실제로 묻는다.** 보고서에 적는 것은 묻는 것이 아닙니다."
      echo "  3. 질문을 한 번이라도 하면 이 게이트는 풀립니다."
      echo
      echo "위양성이라면(그 어휘를 설명·인용한 것이지 결정이 아니라면):"
      echo "  - 백틱이나 따옴표로 감싸면 스캔에서 빠집니다 — 인용은 결정이 아니니까요."
      echo "  - 그래도 걸리면 사용자에게 위양성임을 알리고 지시를 받으세요."
      echo
      echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:decision"
    } >&2
    bump_and_block
  fi
fi

# (3.4) **머리 표명 게이트** (ADR-0013·ADR-0015) — 설계·계획 산출물의 머리 두 줄이
#      표명 형식을 지키는지 본다:
#        1줄 `사전 결정 회수:` (ADR-0013 — ADR-0009 계약의 산문 승격)
#        2줄 `레퍼런스 조사: 조사함(<대상·출처>)|불요(<사유>)|실패(<시도 — 사유>)`
#            (ADR-0015 — "조사가 필요한 지시인가"의 판정은 기계가 못 하므로, 판정의
#             **무표명 통과**를 막는다. 불요에도 사유를 강제하는 것이 핵심이다)
#
#      **형식만 본다.** 진짜 읽었는지·조사했는지는 기계가 못 본다(내용 검증은 검수 몫 —
#      ADR-0013 ④·ADR-0015).
#      **자동 해제** — 형식을 지키면 이 게이트가 스스로 플래그를 지운다. 지울 플래그를
#      에이전트 손에 주지 않는 것이 이 게이트의 형태다(결정 게이트의 "실제로 물으면
#      풀린다"와 같은 구조).
#      **듀얼리뷰(3.5)보다 앞** — 표명 없는 산출물로 리뷰에 노력을 쓰기 전에 잡는 편이
#      싸다. 정확성 문제가 아니라 비용 문제다(ADR-0012 ④와 같은 논리).
if retrieval_pending; then
  if [ ! -r "$RETRIEVAL_FLAG" ]; then
    # 플래그는 서 있는데(-s) 읽을 수 없다 — "검사 대상 0건"으로 위장되면 조용한 통과라
    # fail-closed 로 차단한다. 무엇이 대상이었는지조차 모르는 상태다.
    gate_budget "retrieval:unreadable-flag"
    {
      echo "[완료 차단] 머리 표명 검사 불가 — 플래그 파일을 읽을 수 없습니다: $RETRIEVAL_FLAG"
      echo "권한·손상을 확인한 뒤 다시 종료하세요."
      emit_decision_note
      echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:retrieval"
    } >&2
    bump_and_block
  fi
  # 예산 키 항목은 "경로#검사번호"다(#1 첫 줄 / #2 둘째 줄). 검사 번호까지 넣는 이유:
  # 경로만 넣으면 두 줄 다 불량인 파일의 첫 줄만 고친 **진전**이 키를 못 바꿔, 4회째
  # 예산 소진이 플래그 5종을 전삭제한다(설계 검수 [cx] r2). 사유 문자열은 넣지 않는다 —
  # 같은 검사가 다른 사유로 바뀌는 것은 진전이 아니다.
  retrieval_bad_paths=""   # 불량 항목 "경로#검사번호" (정렬 전, 줄 단위) — 예산 키용
  retrieval_bad_msgs=""    # "경로 — 사유" (차단 메시지용)
  # `|| [ -n "$entry" ]` 가 필수다: 마지막 줄이 개행 없이 끝나면 read 가 값을 담고도
  # rc=1 을 내 본문이 안 돌고, 그 항목이 **조용히 스킵**된다 — record_flag 쓰기가
  # 중단된 플래그에서 표명 없는 산출물이 통과하는 경로였다(구현 검수 [cx] HIGH).
  while IFS= read -r entry || [ -n "$entry" ]; do
    [ -n "$entry" ] || continue                     # 빈 줄은 기록 계약 밖 — 건너뛴다
    case "$entry" in
      /*) rfile="$entry" ;;
      # 기록값 계약(mark-needs-audit): 프로젝트 안은 상대경로다. 훅 실행 cwd 가 아니라
      # **$PROJECT_DIR 기준**으로 연다 — cwd 기준이면 다른 곳에서 실행된 턴에 전부
      # "소실"로 오인돼 불량이 조용히 통과한다([cc·cx] 검수).
      *)  rfile="$PROJECT_DIR/$entry" ;;
    esac
    # 소실은 건너뛴다. 차단하면 산출물을 아카이브한 턴이 벽돌이 된다(고칠 대상이 없다).
    # 이 스킵이 삭제 우회를 연다는 것은 ADR-0013 이 공시한다 — 실존 검증은 감사자 몫.
    [ -e "$rfile" ] || continue
    if [ ! -r "$rfile" ]; then
      retrieval_bad_paths="${retrieval_bad_paths}${entry}#1
"
      retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 파일을 읽을 수 없음
"
      continue
    fi
    rline=""
    rline2=""
    ref_missing=0
    # 머리 2줄을 한 블록 리다이렉트로 읽는다 — 파일을 두 번 열지 않는다. 중괄호 블록은
    # 서브셸이 아니라 대입이 블록 밖에 남고, 리다이렉트는 블록 안에만 적용되므로 바깥
    # while 의 stdin($RETRIEVAL_FLAG)과 충돌하지 않는다.
    {
      IFS= read -r rline || true
      # 둘째 줄 "누락" 판정은 read 의 rc 를 실제로 소비해야 한다. 무개행 마지막 줄에서
      # read 는 값을 담고도 rc=1 을 내므로, rc 만 보면 개행 없는 정상 표명이 누락으로
      # 오판되고 값만 보면 판정이 뭉개진다. 한 줄 관용구(`read || [ -n ]`)는 단발 read
      # 에서 rc 를 아무도 소비하지 않는 no-op 이다(설계 검수 [cc] r2 HIGH — while 루프
      # 조건이던 원본과 자리가 다르다). 그래서 분기로 소비한다.
      if IFS= read -r rline2; then
        :
      elif [ -n "$rline2" ]; then
        :                   # 개행 없는 마지막 줄 — 값이 있으므로 누락이 아니다
      else
        ref_missing=1       # rc!=0 이고 값도 없다 = 둘째 줄이 없다(1줄 파일)
      fi
    } < "$rfile"
    # ── 첫 줄: 회수 표명 (ADR-0013) ──
    # 첫 줄 판정 전에 선두 BOM·후행 CR 을 걷어낸다 — harness_env_value 가 같은 부류
    # (눈에 안 보이는 바이트가 판정을 뒤집는 것)에 데인 전례가 있다.
    rline="${rline#$'\xEF\xBB\xBF'}"
    rline="${rline%$'\r'}"
    case "$rline" in
      "사전 결정 회수:"*)
        if [ -z "$(printf '%s' "${rline#사전 결정 회수:}" | LC_ALL=C tr -d '[:space:]')" ]; then
          retrieval_bad_paths="${retrieval_bad_paths}${entry}#1
"
          retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 표명 접두어 뒤에 내용이 없음
"
        fi
        ;;
      "")
        retrieval_bad_paths="${retrieval_bad_paths}${entry}#1
"
        retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 파일이 비었거나 첫 줄이 빈 줄
"
        ;;
      *)
        retrieval_bad_paths="${retrieval_bad_paths}${entry}#1
"
        retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 첫 줄이 '사전 결정 회수:' 로 시작하지 않음
"
        ;;
    esac
    # ── 둘째 줄: 레퍼런스 표명 (ADR-0015) — 닫힌 문법 ──
    #   레퍼런스 조사:<SP*><변형><SP*>(<내용>)<SP*>
    #   <변형> = 조사함|불요|실패 (정확 일치 — 꼬리 문자가 붙으면 불량)
    #   <SP>   = ASCII 스페이스·탭 뿐 (비ASCII 공백은 SP 가 아니다)
    #   <내용> = LC_ALL=C tr -d '[:space:]' 후 비어있지 않음 (내부 괄호 허용 —
    #            마지막 `)` 가 닫는 괄호. 첫 `)` 로 자르면 `조사함(a(b) c)` 가 잘린다)
    if [ "$ref_missing" -eq 1 ]; then
      retrieval_bad_paths="${retrieval_bad_paths}${entry}#2
"
      retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 둘째 줄 없음(레퍼런스 표명 누락)
"
    else
      rline2="${rline2%$'\r'}"
      case "$rline2" in
        "레퍼런스 조사:"*)
          ref_body="${rline2#레퍼런스 조사:}"
          # 앞뒤 SP(스페이스·탭)만 트림한다 — 트림 후 마지막 문자가 `)` 여야 하므로
          # 닫는 괄호 뒤 잡음은 아래 case 에서 불량으로 떨어진다.
          while :; do
            case "$ref_body" in
              ' '*)  ref_body="${ref_body# }" ;;
              '	'*)  ref_body="${ref_body#	}" ;;
              *' ')  ref_body="${ref_body% }" ;;
              *'	')  ref_body="${ref_body%	}" ;;
              *) break ;;
            esac
          done
          ref_head="${ref_body%%\(*}"
          while :; do
            case "$ref_head" in
              *' ')  ref_head="${ref_head% }" ;;
              *'	')  ref_head="${ref_head%	}" ;;
              *) break ;;
            esac
          done
          if [ "$ref_head" = "$ref_body" ]; then
            # 여는 괄호가 없다 — `불요` 단독(사유 없음)·접두어만 남은 줄이 여기 온다.
            retrieval_bad_paths="${retrieval_bad_paths}${entry}#2
"
            retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 레퍼런스 표명이 조사함(<내용>)/불요(<사유>)/실패(<사유>) 형식이 아님
"
          else
            case "$ref_head" in
              조사함|불요|실패)
                case "$ref_body" in
                  *\))
                    ref_inner="${ref_body#*\(}"
                    ref_inner="${ref_inner%\)}"
                    # 내용 검사는 세 변형 **공통의 단일 경로**다 — 변형별로 복제하면
                    # 한 변형만 검사가 빠지는 부류가 생긴다(`실패()` — 설계 검수 [cx] r2).
                    if [ -z "$(printf '%s' "$ref_inner" | LC_ALL=C tr -d '[:space:]')" ]; then
                      retrieval_bad_paths="${retrieval_bad_paths}${entry}#2
"
                      retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 레퍼런스 표명의 괄호 안이 비었음
"
                    fi
                    ;;
                  *)
                    # 트림 후에도 `)` 로 안 끝난다 — 닫는 괄호 뒤 잡음·미닫힘.
                    retrieval_bad_paths="${retrieval_bad_paths}${entry}#2
"
                    retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 레퍼런스 표명이 조사함(<내용>)/불요(<사유>)/실패(<사유>) 형식이 아님
"
                    ;;
                esac
                ;;
              *)
                # 변형 꼬리(`조사함부족`)·유의어(`불필요`)·비ASCII 공백이 낀 머리.
                retrieval_bad_paths="${retrieval_bad_paths}${entry}#2
"
                retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 레퍼런스 표명이 조사함(<내용>)/불요(<사유>)/실패(<사유>) 형식이 아님
"
                ;;
            esac
          fi
          ;;
        *)
          # 빈 둘째 줄(개행만)도 여기로 온다 — 접두어 사유 하나로 접는다.
          retrieval_bad_paths="${retrieval_bad_paths}${entry}#2
"
          retrieval_bad_msgs="${retrieval_bad_msgs}${entry} — 둘째 줄이 '레퍼런스 조사:' 로 시작하지 않음
"
          ;;
      esac
    fi
  done < "$RETRIEVAL_FLAG"

  if [ -z "$retrieval_bad_paths" ]; then
    # 전부 형식 준수(또는 소실뿐) → 자동 해제. rm 이 실패하면 플래그가 남아 다음 턴에
    # 다시 검사된다 — 게이트가 죽는 방향이 아니라 남는 방향이므로 조용해도 안전하다.
    rm -f "$RETRIEVAL_FLAG" 2>/dev/null
    # 지문을 다시 계산한다 — 진입 시 스냅숏에는 방금 지운 "r" 비트가 남아 있어, 이 턴의
    # 하위 게이트가 stale 지문으로 예산을 매기고 다음 턴에 거짓 리셋이 난다([cc] HIGH).
    compute_flags_fp
    if ! work_pending; then
      # 이 턴의 할 일이 이것뿐이었다 — 여기서 끝내지 않으면 맨 아래 감사 게이트가
      # 빈 목록으로 허위 차단한다([cc·cx] 검수). 술어는 조기 종료와 같은 것을 쓴다 —
      # push 미완·다른 플래그가 남았으면 아래 게이트들로 계속 흘러간다.
      rm -f "$BLOCK_COUNT" "$BLOCK_FP" 2>/dev/null
      if [ -n "${decision_note:-}" ]; then
        # 경고를 삼키지 않는 것이 결정 게이트 fail-open 의 유일한 조건이다(ADR-0012 ②).
        # 성공 경로에도 적용된다 — 예산 소진 경로가 같은 방식으로 싣는다.
        printf '{"systemMessage":"참고: %s — 이 턴에 사용자에게 물었어야 할 결정이 없었는지 스스로 확인하세요."}\n' "$decision_note"
      fi
      exit 0
    fi
  else
    # 예산 키는 게이트 자신에게만 결합한다. 불량 목록을 공유 지문(flags_fp)에 넣으면
    # 다른 게이트의 예산까지 리셋된다. 목록이 줄면(파일을 고치면) 이 게이트의 카운터만
    # 리셋된다 — push 가 "몇 개 남았나"를 지문에 넣는 것과 같은 의도다.
    # 파이프가 실패하거나 빈 값을 내면(제한된 PATH·I/O 오류) 예산 키가 비어 "진전이
    # 리셋을 못 만드는" 상태가 된다([cx] 지적) — 외부 명령 없는 bash 치환으로 폴백한다.
    # 폴백은 정렬이 없어 키 안정성이 낮지만, 같은 플래그 파일은 순서가 유지되므로 실효는 같다.
    retrieval_bad_sorted="$(printf '%s' "$retrieval_bad_paths" | sort -u | tr '\n' ' ')" \
      || retrieval_bad_sorted=""
    [ -n "$retrieval_bad_sorted" ] || retrieval_bad_sorted="${retrieval_bad_paths//$'\n'/ }"
    gate_budget "retrieval:${retrieval_bad_sorted}"
    {
      echo "[완료 차단] 설계·계획 산출물의 머리 표명이 계약과 다릅니다 — 회수(1줄)·레퍼런스 조사(2줄) 표명 없이 만든 산출물로는 끝낼 수 없습니다."
      echo
      echo "형식이 어긋난 파일:"
      printf '%s' "$retrieval_bad_msgs" | sed 's/^/  - /'
      echo
      echo "해야 할 일:"
      echo "  1. 프로필 9절의 지식 진입점을 읽고, 이번 작업과 관련된 항목만 따라가 읽는다."
      echo "  2. 레퍼런스 조사가 필요한 작업이었는지 판단한다 — 필요했으면 조사하고(인접"
      echo "     도메인 포함), 불요·실패라도 사유를 적는다. 조용한 스킵은 없다."
      echo "  3. 산출물 **머리 3줄**을 이 형식으로 맞춘다:"
      echo "     1줄: 사전 결정 회수: <읽은 경로>      또는  사전 결정 회수: 없음(<사유>)"
      echo "     2줄: 레퍼런스 조사: 조사함(<대상·출처>) | 불요(<사유>) | 실패(<시도 — 사유>)"
      echo "          — 이 세 단어와 반각 괄호만. 괄호 안이 비면 불량입니다."
      echo "     3줄~: - 걸리는 선행 결정: <제목 — 한 줄> (없으면 \"- 걸리는 선행 결정 없음\")"
      echo "  4. 형식을 지키면 이 게이트는 스스로 풀립니다 — 지울 플래그가 없습니다."
      echo
      echo "이 게이트는 형식만 봅니다. 진짜 읽었는지·조사했는지는 검수(plan-reviewer·codex)가 봅니다."
      emit_decision_note
      echo
      echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:retrieval"
    } >&2
    bump_and_block
  fi
fi

# --- 3.5 의 추가 관할 폴더 슬롯 판정 (ADR-0026) ---------------------------------------
# 슬롯 리뷰 자리 기록의 형식은 _extra_gate_dirs.sh 가 정본이고, Stop 은 형식을 모른다 —
# 키 판독 상태 · 기록 파일의 존재 · 평가의 rc · 사유 코드 · W/M 줄만 안다.
DR_MODE=""     # loop 기존 루프 · met 슬롯 판정으로 해제 · unmet 슬롯 판정으로 막음 ·
               # root 슬롯 판정으로 막되 남은 것이 세션 루트 자리뿐(기존 막음 안내)
DR_OUT=""      # 평가 출력: 슬롯 상태 한 줄 · 사유 코드 한 줄 · W <자리> · M <값> 줄
DR_RC=0        # 평가 rc: 0 충족 · 3 미충족 · 4 판정 불가(기록·루트) · 5 환경 장애 ·
               # 9 모듈 없음 · 128 이상 신호 종료(원인 모름) · 그 밖 실패(모듈 오류)
DR_ROOT_WS=""  # 평가에 쓴 세션 루트 자리(물리 루트/_workspace) — 막음 안내가 슬롯 자리를 가른다

#######################################
# 서브셸 안에서만 부른다(모듈 적재 실패는 exit 로 알린다). 모듈을 적재해 슬롯을 검증하고
# read_review_verdict 를 돌린다 — 모듈이 죽어도 본 셸은 끝나지 않는다(시험 r06).
# Globals:
#   EXTRA_GATE_RAW (읽음) · EXTRA_GATE_DIR (모듈 전역 — 슬롯이 꺼졌으면 비운다)
# Arguments:
#   $1 — 키 판독 상태(0 VALUE · 1 UNTRUSTED), $2 — 물리 세션 루트
# Outputs:
#   첫 줄 = 평가 때의 슬롯 상태 — on 켜짐 · untrusted harness.env 를 믿을 수 없음 ·
#   invalid 키 값이 검증에 실패. 다음 줄부터 read_review_verdict 의 출력
# Returns:
#   read_review_verdict 의 rc · 9 모듈을 읽지 못함(서브셸이 신호로 죽으면 부른 쪽은
#   128+신호를 받는다)
#######################################
dualreview_eval() {
  { . "$(dirname "${BASH_SOURCE[0]}")/_extra_gate_dirs.sh"; } 2>/dev/null || exit 9
  if [ "$1" -ne 0 ]; then
    EXTRA_GATE_DIR=''
    printf 'untrusted\n'
  elif validate_extra_gate_dir "$EXTRA_GATE_RAW"; then
    printf 'on\n'
  else
    EXTRA_GATE_DIR=''
    printf 'invalid\n'
  fi
  read_review_verdict "$2"
}

#######################################
# 3.5 를 슬롯 리뷰 자리 기록으로 판정할지 정하고, 그렇다면 서브셸에서 평가한다.
#   ABSENT · (UNTRUSTED ∧ 기록 파일 없음)  → loop(기존 루프 원문 — 키가 없으면 바이트 같음)
#   (UNTRUSTED ∧ 기록 있음) · VALUE        → 평가. rc 0 met · 3 unmet · 4 unmet(막음)
#     rc 3 인데 남은 것이 세션 루트 자리뿐  → root(막되 기존 막음 안내가 사실이다)
#     그 밖(모듈 없음 · 사망 · 판독 실패)   → 기록 파일이 있으면(0바이트 포함) unmet,
#                                             없으면 loop(판정자도 기록하지 못했다 — 공시)
# 평가할 수 없을 때의 증거는 기록 파일의 **존재**다 — 기록 줄은 해석하지 않는다.
# Globals:
#   REVIEW_DIRS_FILE, PROJECT_DIR (읽음) · DR_MODE, DR_OUT, DR_RC, DR_ROOT_WS (씀)
#######################################
dualreview_judge_slot() {
  local ks have_rec=0 root
  DR_MODE=loop
  DR_OUT=""
  DR_RC=0
  DR_ROOT_WS=""
  extra_gate_key_state
  ks=$?
  [ "$ks" -eq 3 ] && return 0
  { [ -e "$REVIEW_DIRS_FILE" ] || [ -L "$REVIEW_DIRS_FILE" ]; } && have_rec=1
  [ "$ks" -eq 1 ] && [ "$have_rec" -eq 0 ] && return 0
  # 소속은 물리 세션 루트로 본다 — 판정자가 그렇게 기록했다(시험 e12w). 끝 개행까지
  # 센티널로 받는다 — 명령 치환은 끝 개행을 지워 다른 폴더를 가리킨다. 개행·US 가 든
  # 루트는 모듈이 root-unusable 로 막는다(목록 구분자와 부딪힌다).
  if root="$(CDPATH='' cd -P -- "$PROJECT_DIR" 2>/dev/null && pwd -P && printf x)"; then
    root="${root%x}"
    root="${root%$'\n'}"
  else
    root="$PROJECT_DIR"
  fi
  DR_ROOT_WS="$root/_workspace"
  DR_OUT="$(dualreview_eval "$ks" "$root" 2>/dev/null)"
  DR_RC=$?
  case "$DR_RC" in
    0) DR_MODE=met ;;
    3)
      DR_MODE=unmet
      # 사유가 없고 기다리는 자리가 세션 루트 _workspace 하나뿐이면(줄은 중복 없이 온다)
      # 남은 항목은 세션 루트 규칙이다 — 슬롯 안내가 아니라 기존 막음 안내가 맞다.
      [ "${DR_OUT#*$'\n'}" = $'\n'"W $root/_workspace" ] && DR_MODE=root ;;
    4) DR_MODE=unmet ;;
    *) [ "$have_rec" -eq 1 ] && DR_MODE=unmet ;;
  esac
  return 0
}

#######################################
# 사유 코드의 문구(Stop 상수 — 모듈이 없어도 나간다).
# Arguments:
#   $1 — 사유 코드, $2 — 평가 때의 슬롯 상태(on|untrusted|invalid — dualreview_eval),
#   $3 — 평가 rc(eval-signal 문구에 싣는다)
# Outputs:
#   문구 한 줄(모르는 코드는 코드 그대로)
#######################################
dualreview_reason_text() {
  case "$1" in
    missing-record)
      if [ "$2" = on ]; then
        echo "현재 리뷰 자리 기록이 없다 — 세션 폴더 쓰기와 그 저장소의 git 판독(소유권 · 권한 · 손상)을 확인하고 그 파일을 다시 저장하면 기록된다. 다만 그 값의 기록 줄이 1023바이트를 넘으면 기록할 수 없어(기록 줄 = 값 경로와 리뷰 자리 경로들을 구분 바이트 하나씩으로 이은 것 — 자리는 슬롯 저장소 항목이면 그 저장소의 _workspace 와 옆 _workspace_<저장소> 둘, 설계 산출물은 그 폴더 하나), 다시 저장해도 · 저장소를 옮겨도 이번 막음은 풀리지 않는다 — 사용자에게 알려 판단을 받아라(다음부터 막히지 않게 저장소를 더 짧은 경로로 옮길지는 사용자가 정한다)."
      elif [ "$2" = invalid ]; then
        echo "현재 리뷰 자리 기록이 없다 — 지금은 슬롯이 꺼져 있어 저장해도 기록되지 않는다. harness.env 슬롯 설정을 고친 뒤 위 '현재 리뷰 자리 기록이 없는 값' 의 파일을 다시 저장하라."
      else
        echo "현재 리뷰 자리 기록이 없다 — 지금은 harness.env 를 믿고 읽을 수 없어(손상·읽기 불가·중복 선언·문법 밖·파일 종류) 슬롯이 꺼져 있고 저장해도 기록되지 않는다. harness.env 를 정상으로 읽을 수 있게 고친 뒤 위 '현재 리뷰 자리 기록이 없는 값' 의 파일을 다시 저장하라."
      fi ;;
    unrecordable)
      echo "경로에 제어문자(US)가 있어 리뷰 자리를 기록할 수 없는 값이다(영구) — 다시 저장해도 · 파일 이름을 바꿔도 이번 막음은 풀리지 않는다. 사용자에게 알려 판단을 받아라." ;;
    record-unusable)
      echo "리뷰 자리 기록 파일을 쓰거나 읽을 수 없다 — 세션 폴더의 .review-dirs 가 일반 파일이 아니거나(폴더 · FIFO · 끊긴 링크) 읽기 · 쓰기 권한이 없다. 읽고 쓸 수 있는 일반 파일이 되게(파일 종류 · 권한) 고친 뒤 고친 파일들을 다시 저장하라." ;;
    root-unusable)
      echo "세션 루트 경로에 개행이나 제어문자(US)가 있어 리뷰 자리를 판정할 수 없다 — 사용자에게 알려 판단을 받아라(세션 루트 폴더 이름을 바꿀지, harness.env 의 슬롯 키 줄을 지우거나 값을 비울지는 사용자가 정한다 — 키 값만 틀리게 바꾸면 그대로 막히고, 키 줄을 지우거나 값을 비워도 harness.env 를 정상으로 읽을 수 있을 때만 풀린다. 다른 키가 손상됐으면 그것부터 고친다)." ;;
    module)
      echo "추가 관할 폴더 모듈을 읽지 못해 리뷰 자리를 판정할 수 없다 — 하네스를 다시 설치(sync)하라." ;;
    eval-fail)
      echo "리뷰 자리 판정이 실패했다(모듈 오류) — 하네스를 다시 설치(sync)하라." ;;
    eval-env)
      echo "리뷰 자리 판정이 실패했다(환경 장애 — 판정기 awk 가 돌지 못했거나 판정용 임시 파일을 만들지 못했다: awk 없음 · 파일 권한 · 디스크 공간 · 자원 한도) — 하네스를 다시 설치해도 풀리지 않는다. 사용자에게 알려 판단을 받아라(장애가 걷히면 다음 Stop 이 다시 판정한다)." ;;
    eval-signal)
      echo "리뷰 자리 판정이 신호로 끝났다(rc $3 — 128 이상은 신호 종료) — 원인을 가릴 수 없다. 모듈이 바뀌었거나 망가졌으면 하네스를 다시 설치(sync)하면 풀리지만, 자원 한도(파일 크기 · 메모리) 같은 환경 원인이면 다시 설치해도 풀리지 않는다. 사용자에게 알려 판단을 받아라(원인이 걷히면 다음 Stop 이 다시 판정한다)." ;;
    dir-unknown)
      if [ "$2" = invalid ]; then
        echo "슬롯 폴더를 알 수 없어(harness.env 의 슬롯 값을 쓸 수 없음 — 값 검증 실패) 기록 없는 절대경로 항목은 세션 루트 규칙으로 보았다."
      else
        echo "슬롯 폴더를 알 수 없어(harness.env 를 믿고 읽을 수 없음) 기록 없는 절대경로 항목은 세션 루트 규칙으로 보았다."
      fi ;;
    *) echo "$1" ;;
  esac
}

#######################################
# 슬롯 판정으로 막을 때의 안내(호출자가 stderr 로 돌린다). 기다리는 자리(W)와 현재 기록이
# 없는 값(M)을 나열하고 사유마다 문구를 싣는다(슬롯이 꺼져 있었으면 다시 저장해도
# 기록되지 않으니 출구 문구가 다르다). "해야 할 일"은 실제 해제 조건만 말한다 — 기다리는
# 자리 목록이 없으면 그 자리에 저장하라고 하지 않고, 풀기 전에 해결할 사유가 있을 때만
# "위 사유"를, 슬롯 항목이 남았을 때만 "세션 루트 리뷰로 풀리지 않는다"를 낸다.
# Globals:
#   DR_OUT, DR_RC, DR_ROOT_WS, DUALREVIEW_FLAG, count, MAX_BLOCKS (읽음)
#######################################
dualreview_slot_block() {
  local slot_state='' reasons="" body="" waiting="" missing="" slot_waits=""
  local blocking=0 line code
  case "$DR_RC" in
    0|3|4)
      slot_state="${DR_OUT%%$'\n'*}"
      body="${DR_OUT#*$'\n'}"
      [ "$body" = "$DR_OUT" ] && body=""
      reasons="${body%%$'\n'*}"
      body="${body#*$'\n'}"
      [ "$body" = "$reasons" ] && body="" ;;
    5) reasons=eval-env ;;
    9) reasons=module ;;
    *)
      # 128 이상은 서브셸이 신호로 죽은 것이다(셸 관례 128+신호) — 모듈이 낸 rc 가
      # 아니라 원인(모듈 손상 · 자원 한도)을 가릴 수 없다.
      if [ "$DR_RC" -ge 128 ]; then
        reasons=eval-signal
      else
        reasons=eval-fail
      fi ;;
  esac
  # 기다리는 자리 · 기록 없는 값 목록은 한 번 만들어 나열과 판단이 같은 목록을 보게 한다.
  # sed 는 입력을 끝까지 읽는다 — `printf | grep -q` 로 판단하면 grep 이 첫 일치에서 닫아
  # 큰 본문(파이프 버퍼 초과)의 printf 가 SIGPIPE 로 죽고, pipefail 아래 조건이 거짓이 돼
  # 나열이 조용히 빠진다.
  # 자리 · 값은 바이트열이다 — 로케일에 기대지 않게 LC_ALL=C 로 다룬다(UTF-8 로케일의 GNU
  # grep 은 잘못된 UTF-8 이 든 줄을 이진으로 보고 줄을 내지 않으며 경고를 stderr 에 섞는다).
  waiting="$(printf '%s\n' "$body" | LC_ALL=C sed -n 's/^W /  - /p')"
  missing="$(printf '%s\n' "$body" | LC_ALL=C sed -n 's/^M /  - /p')"
  # 세션 루트 자리 말고 기다리는 자리(슬롯 자리)가 있는가.
  slot_waits="$(printf '%s\n' "$waiting" \
    | LC_ALL=C grep -vxF -- "  - $DR_ROOT_WS" 2>/dev/null)"
  # dir-unknown 은 판정 방식을 알리는 사유라 풀기 전에 해결할 조건이 아니다.
  for code in $reasons; do
    [ "$code" = dir-unknown ] || blocking=1
  done
  echo "[완료 차단] codex 듀얼 리뷰가 그 리뷰 자리에서 확인되지 않았습니다 — 추가 관할 폴더 슬롯 리뷰 자리 기록으로 판정했습니다."
  echo
  echo "이 턴의 듀얼 리뷰 대상: $(wc -l < "$DUALREVIEW_FLAG" 2>/dev/null | tr -d ' ')개 파일 (목록: $DUALREVIEW_FLAG)"
  if [ -n "$waiting" ]; then
    echo
    echo "리뷰를 기다리는 자리(그 폴더에 *codex*.md 를 저장하면 풀린다):"
    printf '%s\n' "$waiting"
  fi
  if [ -n "$missing" ]; then
    echo
    echo "현재 리뷰 자리 기록이 없는 값:"
    printf '%s\n' "$missing"
  fi
  if [ -n "$reasons" ]; then
    echo
    echo "사유:"
    for code in $reasons; do
      line="$(dualreview_reason_text "$code" "$slot_state" "$DR_RC")"
      echo "  - $line"
    done
  fi
  echo
  echo "해야 할 일:"
  echo "  1. 대상 산출물/diff를 codex로 독립 리뷰시킨다 (모델·effort는 guard-codex-invocation 규정 — 임의 하향 금지)."
  if [ -n "$waiting" ]; then
    if [ -n "$slot_waits" ] || [ -n "$missing" ]; then
      echo "  2. 결과를 위 '리뷰를 기다리는 자리'에 *codex*.md 로 저장하고 지적을 [cc]/[cx] 태그로 통합한다 — 슬롯 항목은 세션 루트 _workspace 의 리뷰로 풀리지 않는다."
    else
      echo "  2. 결과를 위 '리뷰를 기다리는 자리'에 *codex*.md 로 저장하고 지적을 [cc]/[cx] 태그로 통합한다."
    fi
    if [ "$blocking" -eq 1 ]; then
      echo "  3. 위 사유를 해결하고 저장하면 다음 Stop 에서 이 게이트가 자동 해제된다 — 지울 플래그가 없습니다."
    else
      echo "  3. 저장하면 다음 Stop 에서 이 게이트가 자동 해제된다 — 지울 플래그가 없습니다."
    fi
  else
    if [ "$blocking" -eq 1 ]; then
      echo "  2. 리뷰를 기다리는 자리를 아직 정할 수 없다 — 위 사유를 먼저 해결하면 다음 Stop 이 그 자리를 알려 준다."
    else
      echo "  2. 리뷰를 기다리는 자리 목록을 만들지 못했다(나열 실패) — 다음 Stop 이 다시 판정한다."
    fi
    echo "  3. 다음 Stop 이 알려 주는 자리에 결과를 *codex*.md 로 저장하고 지적을 [cc]/[cx] 태그로 통합하면 이 게이트가 자동 해제된다 — 지울 플래그가 없습니다."
  fi
  echo "     codex 미설치·호출 실패로 생략하는 경우에만 사용자 보고에 '듀얼 리뷰 생략(codex 실패)'을"
  echo "     명시하고:  rm -f $(flag_hint "$DUALREVIEW_FLAG" .needs-dualreview)"
  echo "     리뷰 없이 플래그만 지우는 것은 이 게이트의 존재 이유를 없앤다."
  echo
  emit_decision_note
  echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:dualreview"
}

# (3.5) 듀얼 리뷰(codex) 게이트 (2026-08-03 kty — "리뷰가 필요한 모든 단계를 codex와 같이"의 기계화).
#      설계·계획 산출물이 저장되거나 코드가 바뀐 턴은 codex 독립 리뷰 없이 끝낼 수 없다.
#      Claude 단독 리뷰가 놓친 CRITICAL을 codex가 잡은 실사고(2026-08-03 POK-30)의 재발 방지.
#
#      **자동 해제** (2026-08-11 감사 지적 (b) — 플래그 존재만 보면 산출물 없이 rm 으로
#      통과된다): 플래그보다 mtime 이 새로운 _workspace/*codex*.md 가 있으면 이 턴에 리뷰
#      산출물이 저장된 것으로 보고 게이트가 스스로 플래그를 지운다 — 지울 플래그를
#      에이전트 손에 주지 않는 것이 게이트의 형태다(회수 게이트 3.4 와 같은 구조).
#      내용은 파싱하지 않는다 — 형식·존재만 본다. 빈 껍데기 파일로 통과하는 우회는
#      남는다(기록된 한계) — 내용 검증은 감사자(completion-auditor) 몫이다(ADR-0013 ④).
#
#      **추가 관할 폴더 슬롯**(ADR-0026): 키가 있으면 위 dualreview_judge_slot 이 결정 표대로
#      슬롯 리뷰 자리 기록으로 판정한다. 키가 없으면 아래 기존 루프 원문 그대로다(출력
#      바이트도 같다). 슬롯 판정으로 남은 것이 세션 루트 자리뿐이면(root) 기존 막음 안내를 낸다.
if [ -s "$DUALREVIEW_FLAG" ] && ! hook_disabled "stop:dualreview"; then
  dualreview_artifact=""
  dualreview_judge_slot
  if [ "$DR_MODE" = loop ]; then
    for _dr in "$PROJECT_DIR/_workspace"/*codex*.md; do
      # 글롭 무매치 리터럴·디렉터리·빈 파일 전부 거른다 — [cx]: -e 만 보면
      # foo-codex.md **디렉터리**나 0바이트 touch 로도 게이트가 풀린다.
      [ -f "$_dr" ] && [ -s "$_dr" ] || continue
      if [ "$_dr" -nt "$DUALREVIEW_FLAG" ]; then
        dualreview_artifact="$_dr"
        break
      fi
    done
  elif [ "$DR_MODE" = met ]; then
    dualreview_artifact="$REVIEW_DIRS_FILE"   # 모든 항목이 제 리뷰 자리에서 풀렸다
  fi
  if [ -n "$dualreview_artifact" ]; then
    rm -f "$DUALREVIEW_FLAG" 2>/dev/null
  fi
  # [cx] rm 실패(플래그 잔존) 시 해제 경로로 내려가면 맨 아래 감사 게이트가 엉뚱한
  # 메시지("completion-auditor 미실행")로 차단한다 — 삭제가 실제로 됐을 때만 해제
  # 경로를 타고, 잔존하면 아래 else 의 dualreview 차단이 정확한 메시지를 낸다.
  if [ -n "$dualreview_artifact" ] && [ ! -e "$DUALREVIEW_FLAG" ]; then
    # 지문을 다시 계산한다 — 진입 시 스냅숏에는 방금 지운 "d" 비트가 남아 있어, 이 턴의
    # 하위 게이트가 stale 지문으로 예산을 매기고 다음 턴에 거짓 리셋이 난다(3.4 와 동일).
    compute_flags_fp
    if ! work_pending; then
      # 이 턴의 할 일이 이것뿐이었다 — 여기서 끝내지 않으면 맨 아래 감사 게이트가
      # 빈 목록으로 허위 차단한다. 술어·경고 처리 모두 3.4 자동 해제 경로와 같다.
      rm -f "$BLOCK_COUNT" "$BLOCK_FP" 2>/dev/null
      if [ -n "${decision_note:-}" ]; then
        # 경고를 삼키지 않는 것이 결정 게이트 fail-open 의 유일한 조건이다(ADR-0012 ②).
        printf '{"systemMessage":"참고: %s — 이 턴에 사용자에게 물었어야 할 결정이 없었는지 스스로 확인하세요."}\n' "$decision_note"
      fi
      exit 0
    fi
  elif [ "$DR_MODE" = unmet ]; then
    gate_budget "dualreview"
    dualreview_slot_block >&2
    bump_and_block
  else
    gate_budget "dualreview"
    {
      echo "[완료 차단] codex 듀얼 리뷰 미수행 — Claude 단독 리뷰로는 끝낼 수 없습니다."
      echo
      echo "이 턴의 듀얼 리뷰 대상: $(wc -l < "$DUALREVIEW_FLAG" 2>/dev/null | tr -d ' ')개 파일 (목록: $DUALREVIEW_FLAG)"
      echo
      echo "해야 할 일:"
      echo "  1. 대상 산출물/diff를 codex로 독립 리뷰시킨다 (모델·effort는 guard-codex-invocation 규정 — 임의 하향 금지)."
      echo "  2. 결과를 _workspace/ 에 *codex*.md 로 저장하고 지적을 [cc]/[cx] 태그로 통합한다."
      echo "  3. 산출물을 저장하면 다음 Stop 에서 이 게이트가 자동 해제된다 — 지울 플래그가 없습니다."
      echo "     codex 미설치·호출 실패로 생략하는 경우에만 사용자 보고에 '듀얼 리뷰 생략(codex 실패)'을"
      echo "     명시하고:  rm -f $(flag_hint "$DUALREVIEW_FLAG" .needs-dualreview)"
      echo "     리뷰 없이 플래그만 지우는 것은 이 게이트의 존재 이유를 없앤다."
      echo
      emit_decision_note
      echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:dualreview"
    } >&2
    bump_and_block
  fi
fi

# (4) change-explainer 게이트 (Phase 5) — 감사자보다 먼저 강제한다.
#     코드가 바뀐 턴은 변경 설명 없이 끝낼 수 없다. change-explainer 가 실제로
#     사용자용 설명을 낸 뒤에만 .needs-explain 을 지운다.
#     (완료 감사와 별개로 이 게이트만 끄려면 ECC_DISABLED_HOOKS=stop:explain)
if [ -s "$EXPLAIN_FLAG" ] && ! hook_disabled "stop:explain"; then
  gate_budget "explain"
  {
    echo "[완료 차단] change-explainer 미실행 — 변경 설명 없이 끝낼 수 없습니다."
    echo
    echo "이 턴에서 바뀐 코드/설정: $(wc -l < "$EXPLAIN_FLAG" 2>/dev/null | tr -d ' ')개 파일 (목록: $EXPLAIN_FLAG)"
    echo
    echo "해야 할 일:"
    echo "  1. change-explainer 에이전트로 실제 diff 기반 사용자용 변경 설명을 낸다."
    echo "  2. 설명을 낸 뒤에만:  rm -f $(flag_hint "$EXPLAIN_FLAG" .needs-explain)"
    echo "     설명 없이 플래그만 지우는 것은 이 게이트의 존재 이유를 없앤다."
    echo
    emit_decision_note
    echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:explain"
  } >&2
  bump_and_block
fi

# (5) 지식 저장소 반영 게이트 — 감사보다 먼저 강제한다 (감사자가 반영 결과를 검증하도록).
#     (2026-08-02 kty — 산문 규칙이 세션 내내 0회 이행된 실사고의 기계화)
#
#     **이 훅이 아는 것은 계약 하나뿐이다**: "지식 저장소가 설정돼 있으면, 결정·설계가
#     나온 턴은 반영 없이 끝낼 수 없다." 저장소가 어디인지·어떤 구조인지·무엇을 어느
#     파일에 나눠 담는지는 **상위 층의 구현**이고 이 파일은 모른다. 알게 되면 그 저장소를
#     안 쓰는 환경에서 하네스가 없는 구조를 요구하게 된다(제0원칙 4 — 구체가 아닌 계약).
#     어디에 어떻게 저장했는지의 검증은 그 저장소 자신의 규약이 한다.
if knowledge_gate_active && ! hook_disabled "stop:knowledge"; then
  gate_budget "knowledge"
  {
    echo "[완료 차단] 지식 저장소 반영 미확인 — 이 턴의 결정·설계를 남기지 않고 끝낼 수 없습니다."
    echo
    echo "이 턴에서 바뀐 코드/설정: $(wc -l < "$KNOWLEDGE_FLAG" 2>/dev/null | tr -d ' ')개 파일 (목록: $KNOWLEDGE_FLAG)"
    echo
    echo "해야 할 일:"
    echo "  1. 이 머신의 지식 저장소가 **어디이고 어떤 형식인지는 사용자 층 설정**(전역"
    echo "     CLAUDE.md 등)이 답한다. 그 규약을 **전문** 읽는다 — 부분 독해 금지."
    echo "  2. 이번 턴에 결정·설계·개발작업이 있으면 그 규약대로 반영하고, 반영됐다는"
    echo "     확인 가능한 증거(커밋 해시·파일 경로 등)를 확보한다."
    echo "     판단을 만든 **근거(raw)** 도 규약이 정한 자리에 함께 남긴다 — 요약만 남기면"
    echo "     \"왜 그렇게 정했나\"가 복원 불가능해진다."
    echo "  3. 반영할 지식이 없으면(순수 버그픽스·기계적 수정) 불요 사유를 _workspace/progress.md 에 기록한다."
    echo "  4. 2 또는 3을 마친 뒤에만:  rm -f $(flag_hint "$KNOWLEDGE_FLAG" .needs-knowledge)"
    echo "     completion-auditor 가 그 증거(또는 불요 사유의 타당성)를 검증한다."
    echo "  5. 지식 저장소를 아예 쓰지 않는 환경이면 harness.env 의 HARNESS_KNOWLEDGE_GATE 를 비운다."
    echo
    emit_decision_note
    echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:knowledge"
  } >&2
  bump_and_block
fi

# (5.5) **커밋했는데 원격에 없다** — 이 저장소가 커밋 29개를 잃은 바로 그 상태다.
#      그때는 "아직 PR 전이니까"라며 라운드 6개를 미뤘고, 임시 폴더째 사라졌다.
#      탐지는 (0) 에서 이미 했다 — 조기 종료보다 앞이어야 하기 때문이다.
if [ -n "$push_unsent" ]; then
  gate_budget "push"
  {
    echo "[완료 차단] 커밋이 원격에 없습니다 — $push_unsent"
    echo
    echo "이 저장소는 이 상태로 **커밋 29개를 잃은 적이 있습니다.** 그때도 코드는"
    echo "다 짜여 있었고, \"아직 PR 전이니까\"라며 push 를 미뤘습니다."
    echo
    echo "해야 할 일:"
    echo "  git push -u origin $push_branch"
    echo "  그리고 실제로 올라갔는지 확인하세요:"
    echo "  git rev-list --left-right --count HEAD...origin/$push_branch   → 0 0"
    echo
    echo "  원격에는 있는데 위 명령이 실패한다면 refspec 이 좁혀진 것입니다:"
    echo "  git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git fetch origin"
    echo "  push 여부가 로컬에서 안 보이는 것 자체가 위험합니다 — 29개를 잃을 때 그랬습니다."
    echo
    emit_decision_note
    echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=stop:push"
  } >&2
  bump_and_block
fi

# (6) 타입체크는 통과했지만 감사자가 아직 안 돌았다.
gate_budget "audit"
{
  echo "[완료 차단] completion-auditor 미실행 — '완료'라고 말할 수 없습니다."
  echo
  echo "이 턴에서 바뀐 코드/설정: $(wc -l < "$AUDIT_FLAG" 2>/dev/null | tr -d ' ')개 파일 (목록: $AUDIT_FLAG)"
  if [ -n "$typecheck_note" ]; then
    echo
    echo "참고: $typecheck_note"
  fi
  if [ -n "$stylecheck_note" ]; then
    echo
    echo "참고: $stylecheck_note"
  fi
  emit_decision_note
  echo
  echo "해야 할 일:"
  echo "  1. completion-auditor 에이전트로 완료 주장을 1차 증거로 검증한다."
  echo "  2. 검증을 통과했을 때만:  rm -f $(flag_hint "$AUDIT_FLAG" .needs-audit)"
  echo "     감사 없이 플래그만 지우는 것은 이 게이트의 존재 이유를 없앤다."
  echo
  echo "차단 $((count + 1))/${MAX_BLOCKS}.  탈출구(사용자 전용 — 셸에서 직접 export해야 하며, 에이전트가 대입을 시도하면 guard-hook-disable에 차단됨): HARNESS_HOOKS=off  또는  ECC_DISABLED_HOOKS=$HOOK_ID"
} >&2
bump_and_block
