#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): harness.env 편집 직후, 알려진 키를 **실제 판독기로**
# 읽어 "문법 밖이라 미설정으로 취급될" 키를 그 자리에서 알린다 (ADR-0016).
#
# 왜 필요한가: harness.env 는 실행되지 않고 좁은 문법으로 판독된다(_common.sh 주석).
# 그 대가로 문법을 조금만 틀리면 값이 **조용히 미설정 취급**되고 해당 검사가 생략된다 —
# 원인(편집 실수)과 발각(턴 종료 게이트 메시지) 사이가 멀수록 비싼, 조용한 실패 부류다.
# 이 훅이 그 거리를 0 으로 줄인다.
#
# 판정은 harness_env_value 하나뿐이다 — **규칙의 사본을 만들지 않는다.** 훅이 문법을
# 다시 해석하는 순간 두 규칙이 어긋나는 날이 온다. 그래서 판독기의 반환 계약(rc=1
# 못 믿음 / rc=3 부재)을 소비만 한다: 부재는 안 쓰는 키의 정상 상태라 침묵하고,
# "못 믿음"만 경고한다. 이 구분이 없으면 키를 안 쓰는 프로젝트의 모든 편집에 경고가
# 떠서 경고가 소음이 된다.
#
# 알려진 키 목록은 여기가 유일 지점이다. 목록에 없는 키(오타 HARNESS_TYPECHEK_CMD 등)는
# **못 잡는다** — 잡으려면 파일의 선언을 직접 파싱해야 하는데 그게 규칙의 사본이다(공시).
#
# PostToolUse 는 절대 차단하지 않는다(도구는 이미 실행됨). 항상 exit 0.
# 셸 이식성: macOS 기본 bash 는 3.2 다. ${var,,}·mapfile·연관배열 금지.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

HOOK_ID="post:edit:harness-env"
hook_disabled "$HOOK_ID" && exit 0

KNOWN_KEYS="HARNESS_TYPECHECK_CMD HARNESS_STYLECHECK_CMD \
HARNESS_KNOWLEDGE_GATE HARNESS_PUBLISH_REVIEW_WINDOW_MIN $EXTRA_GATE_KEY"

payload="$(cat)"
bind_session_state "$(printf '%s' "$payload" | json_get session_id)"   # 세션 루트(.root)를 찾으려고
bind_project_dir "$(printf '%s' "$payload" | json_get cwd)"
# 명령 치환의 후행 개행 흡수를 센티널로 막는다 — mark-needs-audit 와 같은 관용구.
raw="$(printf '%s' "$payload" | json_get tool_input.file_path; printf 'X')"
raw="${raw%X}"
file_path="${raw%$'\n'}"
[ -z "$file_path" ] && exit 0

# 개행이 든 경로는 판정하지 않는다 — mark-needs-audit 가 이미 systemMessage 로 알린다.
case "$file_path" in
  *$'\n'*) exit 0 ;;
esac

# 상대경로는 입력 cwd 기준이다(mark-needs-audit 와 같은 원칙 — [cx] r1). cwd 가 없으면 루트 기준.
case "$file_path" in
  /*) envfile="$file_path" ;;
  *)
    case "$HARNESS_CWD" in
      /*) envfile="$HARNESS_CWD/$file_path" ;;
      *)  envfile="$PROJECT_DIR/$file_path" ;;
    esac ;;
esac

# 디렉토리 성분을 물리화한 **뒤에** 앵커를 판정한다 — `.`/`..`/심링크 경유 표기
# (.claude/harness/./harness.env)가 문자열 앵커를 피해가면 잘못된 값이 무경고로
# 통과한다(위음성 — 구현 검수 [cx]). mark-needs-audit 의 physical_path 와 같은 이유,
# 축약형이다. 물리화 실패(디렉토리 없음)면 원본으로 판정을 잇는다 — 정규화 실패가
# 게이트를 지우면 조용한 위음성이 된다.
env_dir="$(CDPATH='' cd -P -- "$(dirname -- "$envfile")" 2>/dev/null && pwd -P)"
if [ -n "$env_dir" ]; then
  [ "$env_dir" = '/' ] && env_dir=''
  envfile="$env_dir/$(basename -- "$envfile")"
fi

# 이 훅의 대상은 하네스가 규정한 자리의 harness.env 뿐이다. 다른 이름·다른 자리는
# 하네스 설정이 아니다(동명 파일 오탐 방지 — .claude/harness/ 앵커까지 요구).
case "$envfile" in
  */.claude/harness/harness.env) ;;
  *) exit 0 ;;
esac

bad_keys=""
for key in $KNOWN_KEYS; do
  # 판독기의 stderr(읽기 실패 경고)는 버린다 — 이 훅이 자기 메시지로 대신 알린다.
  harness_env_value "$key" "$envfile" >/dev/null 2>&1
  case "$?" in
    0|3) ;;                              # 판독됨 / 부재(안 쓰는 키) — 정상, 침묵
    *)   bad_keys="${bad_keys}${key} " ;;  # 못 믿음 — 경고 대상
  esac
done

# 키 이름은 [A-Z_] 뿐이라 JSON 이스케이프가 필요 없다. 경로는 넣지 않는다 —
# 넣는 순간 이스케이프 기계장치가 딸려온다(mark-needs-audit 의 메시지 계약과 동일).
# 결과 안내는 키 종류별로 정직하게 — 검사 명령 키는 검사가 생략되지만, 게이트 스위치
# 키는 안전측(켜짐)으로 동작한다(fail-closed). "생략된다"로 뭉치면 스위치 키에서
# 실물과 반대인 안내가 된다(구현 검수 [cx]). 셋째 종류인 관할 폴더 키는 슬롯이 꺼진다
# — 그 안내는 그 키가 나열됐을 때만 붙인다(없으면 기존 바이트 그대로).
# 안내문에 키 이름을 예시로 넣지 않는다 — 나열된 키만 키 이름이어야 "정상 키가 불량으로
# 나열됐다" 단언(c02·c03)이 성립한다.
msg=""
if [[ -n "$bad_keys" ]]; then
  slot_note=""
  case " $bad_keys" in
    *" $EXTRA_GATE_KEY "*)
      slot_note=" 관할 폴더 키는 슬롯이 꺼져 슬롯 폴더 안 저장소 편집에 게이트가 서지 않습니다."
      ;;
  esac
  msg="harness.env 판독 경고: ${bad_keys}— 이 키의 값을 믿을 수 없습니다(중복 선언·지원 문법 밖·닫히지 않은 따옴표·읽기 실패 중 하나). 판독기는 이런 값을 미설정으로 취급합니다 — 검사 명령 키는 검사가 조용히 생략되고, 게이트 스위치 키는 안전측인 켜짐으로 동작합니다.${slot_note} 파일 첫머리의 문법 규칙을 확인하세요."
fi

# 관할 폴더 값은 읽혀도 쓸 수 없을 수 있다(형식·없는 폴더·모듈 유실) — 그러면 슬롯이
# 꺼지므로 같은 줄에 알린다. 검증은 슬롯 모듈의 것을 그대로 쓴다(규칙의 사본 금지).
# 모듈이 없으면 사유 문구는 _common.sh 에서 나간다.
extra_gate_key_state "$envfile"
key_state=$?
# 판독기는 부재(rc 3)라 하는데 자리가 읽을 수 없는 꼴이면(폴더·끊긴 링크·일반 파일 아래)
# 래퍼가 UNTRUSTED 다 — 판독 불가 목록에 이 키가 없으면 여기서 따로 알린다(침묵 금지).
if [[ "$key_state" -eq 1 ]]; then
  case " $bad_keys" in
    *" $EXTRA_GATE_KEY "*) ;;
    *)
      slot_msg="harness.env 추가 관할 폴더 경고: $(extra_problem_text untrusted)."
      slot_msg="$slot_msg 슬롯이 꺼져 슬롯 폴더 안 저장소 편집에 게이트가 서지 않습니다."
      msg="${msg:+$msg }$slot_msg" ;;
  esac
fi
if [[ "$key_state" -eq 0 ]]; then
  problem=""
  slot_module="$(dirname "${BASH_SOURCE[0]}")/_extra_gate_dirs.sh"
  if ! { . "$slot_module"; } 2>/dev/null; then
    problem="module"
  elif ! validate_extra_gate_dir "$EXTRA_GATE_RAW" 2>/dev/null; then
    problem="${EXTRA_GATE_PROBLEM:-module}"
  fi
  if [[ -n "$problem" ]]; then
    slot_msg="harness.env 추가 관할 폴더 경고: $(extra_problem_text "$problem")."
    slot_msg="$slot_msg 슬롯이 꺼져 슬롯 폴더 안 저장소 편집에 게이트가 서지 않습니다."
    msg="${msg:+$msg }$slot_msg"
  fi
fi
[[ -z "$msg" ]] && exit 0
printf '{"systemMessage":"%s"}\n' "$msg"
exit 0
