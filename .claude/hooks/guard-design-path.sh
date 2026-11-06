#!/usr/bin/env bash
# PostToolUse(Skill) · PreToolUse(Write|Edit|MultiEdit|NotebookEdit):
# 설계·계획 산출물은 harness-orchestrator 경로로만 낳는다. (도메인-무관 재사용 템플릿)
#
# 왜 필요한가 (실사고 2026-08-31):
#   오케스트레이터가 harness-orchestrator 를 태우지 않고 설계서를 **직접** 썼다. 그러면
#   프로필의 "지식 진입점" 절이 통째로 적용되지 않는다 — 그 절의 `[읽는 이]` 는
#   clarifier·architect·planner·plan-reviewer 이고, 선행 결정 회수 프로토콜의 정본은
#   harness-orchestrator SKILL.md 의 dispatch 계약이기 때문이다. 결과: 설계서 3판이
#   **낡은 정본** 위에 섰고, 듀얼 리뷰 두 라운드가 그것을 다시 발견하는 데 소모됐다.
#
# 판정 축 (2026-08-31 듀얼 리뷰 [cx] 반영으로 재작성):
#   초판은 "면제 목록 먼저, 설계 판정 나중"의 배타 구조였다 — 면제 부분문자열이 하나만
#   섞여도 설계 판정을 아예 안 해서 `10_설계서_리뷰반영본.md` 가 통과했다([cx H-4] 실측 5/5).
#   재작성판은 **면제 목록 자체를 없앴다**: 설계 패턴을 문서 유형 토큰(설계서·계획서 등)과
#   앵커드 영문 패턴으로 좁혀서, 리뷰 판정문·raw·색인·입력서가 **애초에 설계 패턴에 안 걸린다**.
#   상위 층 어휘(색인·입력서 등)를 하네스가 아는 문제([cx M-5])도 같이 사라진다.
#
# 무엇을 하나:
#   1) PostToolUse(Skill): harness-orchestrator 가 **성공적으로 실행되면** 세션에 도장.
#      (초판은 PreToolUse 라 존재하지 않는 스킬 호출도 도장을 찍었다 — [cx H-2])
#   2) PreToolUse(쓰기 도구): 설계·계획 산출물인데 이 세션의 도장이 없으면 차단(rc=2).
#
# 상태 파일: $STATE_DIR/.harness-path.<cksum(session)> — 세션별 파일. 내용은 세션 식별자
#   한 줄. 병렬 세션이 서로의 도장을 덮지 않는다([cx M-2]). 임시 파일 → mv 원자 쓰기.
#   세션이 끝나도 파일은 남지만(수십 바이트) 값 대조 때문에 다른 세션을 통과시키지 못한다.
#
# 실패 방향: **잠기는 쪽으로 실패한다**([cx H-3]). 공용 모듈 로드 실패·JSON 파싱 실패·
#   경로 필드 부재는 쓰기 게이트에서 rc=2 다. 이웃 guard-publish-review.sh 와 같은 방향.
#
# 알려진 한계(정직 고지 — [cx H-1]·[cx M-6]):
#   - Bash/PowerShell 리다이렉트·mv·cp, 파일 쓰기 MCP 도구는 이 훅의 매처 밖이다.
#   - **직접 슬래시 호출(`/harness-orchestrator`)은 Skill 도구를 우회해 도장이 안 찍힌다**
#     ([cx r2 M-1]) — 그 세션에서 설계 쓰기가 막히면 Skill 도구 경유로 다시 태워야 한다.
#   - 도장 파일은 모델이 쓸 수 있는 경로라 위조 가능하다.
#   - 도장이 증명하는 것은 "Skill 도구가 harness-orchestrator 지시문을 로드했다"까지다 —
#     파이프라인 완주를 증명하지 않는다([cx r2 M-3]).
#   - 설계 패턴 밖의 새 명명(예: `10_아키텍처안.md`·`설계.md`)은 못 잡는다.
#   - 범용 `-plan.md`/`-design.md` 문서(`migration-plan.md` 등)는 차단된다(위 공시 결정) —
#     하네스 정의 디렉터리 밖에서 그 이름을 쓰려면 도장이 필요하다.
#   **과속방지턱이지 방벽이 아니다.** 막혔다는 사실이 안전을 보증하지 않는다.
#
# 셸 이식성: macOS 기본 bash 3.2. ${var,,}·mapfile·연관배열 금지.

set -uo pipefail

# 공용 모듈 로드 실패 = 차단. 조용히 통과하면 게이트 전체가 무단 소멸한다([cx H-3]).
if ! . "$(dirname "${BASH_SOURCE[0]}")/_common.sh" 2>/dev/null; then
  echo "[설계 경로 강제] 공용 모듈(_common.sh)을 로드하지 못했습니다 — 안전하게 차단합니다." >&2
  exit 2
fi

HOOK_ID="pre:write:design-path"
hook_disabled "$HOOK_ID" && exit 0

payload="$(cat)"

# JSON 유효성을 먼저 못박는다. json_get 은 파싱 실패를 빈 문자열로 접는데,
# 그 빈 값이 "쓰기 도구가 아님"과 구분되지 않아 fail-open 이 됐다([cx H-3]).
# 타입까지 검증한다([cx r2 M-2]) — json_get 은 배열·불리언도 문자열화해 통과시켰다.
if ! printf '%s' "$payload" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if not isinstance(d, dict): sys.exit(1)
for k in ("tool_name", "session_id"):
    if k in d and not isinstance(d[k], str): sys.exit(1)
ti = d.get("tool_input")
if ti is not None:
    if not isinstance(ti, dict): sys.exit(1)
    for k in ("file_path", "notebook_path", "skill"):
        if k in ti and not isinstance(ti[k], str): sys.exit(1)
' 2>/dev/null; then
  echo "[설계 경로 강제] 훅 입력 JSON 파싱·타입 검증에 실패했습니다 — 안전하게 차단합니다." >&2
  exit 2
fi

tool="$(printf '%s' "$payload" | json_get tool_name)"
session="$(printf '%s' "$payload" | json_get session_id)"
bind_session_state "$session"   # 세션 루트(.root)를 찾으려고 — 상태 플래그는 쓰지 않는다
bind_project_dir "$(printf '%s' "$payload" | json_get cwd)"

stamp_path() {  # $1=session → 세션별 도장 경로. cksum 은 POSIX·bash3.2 안전.
  printf '%s/.harness-path.%s' "$STATE_DIR" "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"
}

# --- 1) 도장: harness-orchestrator 실행 완료 (PostToolUse 에 배선) --------------
if [ "$tool" = "Skill" ]; then
  skill="$(printf '%s' "$payload" | json_get tool_input.skill)"
  # 정확 일치만. 부분 문자열 매치는 "not-harness-orchestrator-x" 도 도장을 찍었다([cx H-2]).
  # 플러그인 접두(<plugin>:harness-orchestrator)는 **불허** — 임의 플러그인이 같은 이름의
  # 스킬을 제공하면 도장을 받는 신뢰 구멍이 된다([cx r3 M-1]). 이 스킬은 프로젝트 소유다.
  case "$skill" in
    harness-orchestrator)
      if [ -n "$session" ]; then
        STAMP="$(stamp_path "$session")"
        tmp="$STAMP.tmp.$$"
        if mkdir -p "$STATE_DIR" 2>/dev/null \
           && printf '%s\n' "$session" > "$tmp" 2>/dev/null \
           && mv "$tmp" "$STAMP" 2>/dev/null; then
          :
        else
          # PostToolUse 라 차단은 못 한다. 침묵은 다음 쓰기에서 엉뚱한 사유의 차단이 되므로
          # 경고를 남긴다([cx M-2]).
          rm -f "$tmp" 2>/dev/null
          echo "[설계 경로 강제] 도장 기록 실패($STAMP) — 이 세션의 설계 쓰기가 차단될 수 있습니다." >&2
        fi
      fi
      ;;
  esac
  exit 0
fi

# --- 2) 게이트: 설계·계획 산출물인가 -------------------------------------------
raw="$(printf '%s' "$payload" | json_get tool_input.file_path; printf 'X')"
raw="${raw%X}"
file_path="${raw%$'\n'}"
if [ -z "$file_path" ]; then
  # NotebookEdit 는 notebook_path 를 쓴다([cx H-1]).
  raw="$(printf '%s' "$payload" | json_get tool_input.notebook_path; printf 'X')"
  raw="${raw%X}"
  file_path="${raw%$'\n'}"
fi
if [ -z "$file_path" ]; then
  # 유효한 JSON 인데 경로 필드가 없다 — 이 매처(쓰기 도구)에선 있어야 정상이다.
  # 새 도구 스키마·비문자열 경로가 조용히 새는 것을 막는다([cx H-3]).
  echo "[설계 경로 강제] 쓰기 도구 호출에서 파일 경로를 읽지 못했습니다 — 안전하게 차단합니다." >&2
  exit 2
fi

# ── 경로 판정 일원화 (r6 python 통합 → r7 듀얼로 재보강) ──────────────────
# NFC·정준화(realpath)·anchor 판정·**설계 이름 판정까지** python3 한 단계 안에서 끝내고,
# 셸에는 개행이 섞일 수 없는 **단일 토큰**(EXEMPT|DESIGN|OK)만 돌려준다. 이유(전부 실측):
#  - [cc r7 H-1 = cx r7 M-1] basename 에 개행이 들면 줄 프로토콜의 마지막 줄만 검사돼
#    개행 낀 설계 이름이 무경고 통과했다 — basename 을 셸로 왕복시키는 한 불가피.
#  - [cx r7 H-1] dangling 링크가 "존재하지 않는 꼬리"로 오인돼 anchor 안 링크로 밖에
#    쓸 수 있었다 → 실존 판정을 lexists(링크 자체) 기준으로.
#  - [cx r7 H-2] NFC 를 파일시스템 조회보다 먼저 적용하면 정규화 민감 FS(Linux)에서
#    NFD 경로와 NFC 형제가 합쳐진다 → 물리 해소는 원문으로, NFC 는 이름 판정에만.
#  - (승계) r6: `..`·링크 탈출 정준화 · 후행 슬래시·별칭·NFD 루트 · tr/basename 제거.
# 알려진 한계(공시): 판정은 **검사 시점** 기준이다 — 검사 후 링크를 바꿔치는 TOCTOU 는
# 이 훅의 방벽 밖이다([cx r7 M-2]). 존재하지 않는 꼬리의 대소문자는 정확 일치 요구.
verdict="$(python3 - "$file_path" "$PROJECT_DIR" "${HOME:-}" <<'PYEOF'
import os, re, sys, unicodedata

def canon(p):
    # 가장 가까운 **실존(lexists — dangling 링크 포함)** 조상까지 realpath 로 해소하고,
    # 나머지 꼬리는 어휘적으로 결합한다. NFC 는 여기서 적용하지 않는다([cx r7 H-2]).
    head, tail = p, []
    while head and not os.path.lexists(head):
        head, last = os.path.split(head)
        if not last:
            break
        tail.append(last)
    head = os.path.realpath(head) if head else os.path.realpath(".")
    for c in reversed(tail):
        head = os.path.join(head, c)
    return os.path.normpath(head)

fp, proj, home = sys.argv[1], sys.argv[2], sys.argv[3]
cf = canon(fp)

# 개행·CR 은 anchor 판정보다 **먼저** 거부한다 — 순서가 뒤면 정의 디렉터리 안의 개행
# 이름이 EXEMPT 로 빠져 "개행 이름 무조건 차단" 공시가 깨진다([cx r8 M-1]).
# basename 만이 아니라 경로 전체 기준: 어떤 정당한 경로에도 개행은 없다.
if "\n" in cf or "\r" in cf:
    print("DESIGN")
    sys.exit(0)

def under(root, subs):
    if not root:
        return False
    r = canon(root)
    for sub in subs:
        base = os.path.join(r, ".claude", sub)
        if cf == base or cf.startswith(base + os.sep):
            return True
    return False

if under(proj, ("agents", "commands", "skills")) or under(home, ("agents", "commands", "skills", "plugins")):
    print("EXEMPT")
    sys.exit(0)

# 설계·계획 이름 판정 — NFC 정규화·소문자화한 basename 에 대해, 종전 셸 case 와 같은 계약:
# 한글 문서 유형 토큰 + .md / 영문은 번호 앵커·선행·후행 전부 [_-] 경계 + 정확 이름.
b = unicodedata.normalize("NFC", os.path.basename(cf)).lower()
korean = ("설계서", "설계안", "계획서", "계획안")
design = False
if b.endswith(".md"):
    if any(t in b for t in korean):
        design = True
    elif re.match(r"^[0-9][0-9]_(design|plan)(\.md$|[_-].*\.md$)", b):
        design = True
    elif re.match(r"^(design|plan)(\.md$|[_-].*\.md$)", b):
        design = True
    elif re.search(r"[_-](design|plan)\.md$", b):
        design = True
print("DESIGN" if design else "OK")
PYEOF
)"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "[설계 경로 강제] 경로 정규화·판정 단계가 실패했습니다 — 안전하게 차단합니다." >&2
  exit 2
fi
case "$verdict" in
  EXEMPT|OK) exit 0 ;;
  DESIGN) : ;;
  *)
    echo "[설계 경로 강제] 경로 판정 출력이 비정상입니다 — 안전하게 차단합니다." >&2
    exit 2 ;;
esac

# 도장 대조 — 이 세션의 도장만 유효하다.
stamped=""
if [ -n "$session" ]; then
  STAMP="$(stamp_path "$session")"
  [ -f "$STAMP" ] && stamped="$(cat "$STAMP" 2>/dev/null)"
fi
if [ -n "$session" ] && [ "$stamped" = "$session" ]; then
  exit 0
fi

cat >&2 <<'MSG'
[설계 경로 강제] 설계·계획 산출물을 harness-orchestrator 경로 밖에서 쓰려 했습니다.
MSG
printf '\n  대상: %s\n\n' "$file_path" >&2
cat >&2 <<'MSG'
이 게이트가 있는 이유: 오케스트레이터가 직접 설계서를 쓰면 프로필의 **지식 진입점 절이
적용되지 않습니다** — 그 절의 [읽는 이]는 clarifier·architect·planner·plan-reviewer 이고,
선행 결정 회수 프로토콜의 정본은 harness-orchestrator SKILL.md 의 dispatch 계약입니다.
그것을 건너뛰면 설계가 **낡은 정본** 위에 서고, 듀얼 리뷰가 그걸 다시 발견하는 데
라운드를 씁니다 (2026-08-31 실사고).

할 일:
  1) Skill 도구로 harness-orchestrator 를 호출하고, 그 파이프라인이
     architect 에게 dispatch 하게 하십시오(착수 전 회수 3단계가 거기 붙어 있습니다).
  2) 산출물은 _workspace/NN_design_*.md · NN_plan_*.md 로 먼저 낳으십시오 —
     그래야 머리 표명 게이트(.needs-retrieval)가 함께 걸립니다.
     지식 저장소 이관은 그 게이트를 통과한 뒤입니다.

끄는 것은 사용자만 정합니다 — 막혔으면 우회하지 말고 사용자에게 보고하십시오.
MSG
exit 2
