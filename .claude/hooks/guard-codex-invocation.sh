#!/usr/bin/env bash
# codex 호출 규율 훅 (2026-08-01 kty 지시)
# 모든 `codex exec` 호출은 모델 gpt-6.1-sol + effort xhigh 고정.
# 2026-09-27 kty 지시로 high → xhigh — high 는 이제 하향이다.
# 2026-09-28 kty 지시로 모델을 gpt-6-sol 에서 gpt-5.6-sol 로 되돌렸다.
# 2026-10-01 kty 지시로 모델을 gpt-5.6-sol 에서 gpt-6.1-sol 로 올렸다.
# 오케스트레이터가 "작업이 작다/비용" 이유로 임의 하향한 사고의 재발을 기계로 차단한다.
# 변경이 필요하면 이 훅과 하네스 SKILL.md를 함께 고친다 — 사용자 승인 필수.
#
# 검사 방식 (2026-08-03 재작성 — codex 교차 리뷰 [cx] 지적 반영):
#   shlex 토큰화로 명령 위치의 `codex exec` 호출을 찾고, **호출별로** 그 호출의 인자에서
#   모델·effort를 검사한다. 이유:
#   - 전체 문자열 검사는 "금지 호출; 규정 호출" 연쇄에서 뒤 호출의 옵션이 앞 호출을 가려줬다.
#   - 인용 문자열은 한 토큰이 되므로 커밋 메시지·문서 속 "codex exec"(연결자 포함) 오탐이 없다.
#   - 환경변수 접두(FOO=1 codex …)·예약어(if/then/! …) 뒤의 호출도 명령 위치로 인식한다.
#   알려진 한계(위협 모델 밖 — 기록만): 백틱 치환 내부, 인자 있는 접두 옵션 뒤(sudo -u user /
#   env -u FOO), brace group({ … ; }) 내부는 못 보고, "command -v codex exec" 같은 조회 문자열은
#   오탐 차단될 수 있다. 게이트는 정직한 드리프트 방지용이지 적대 방어가 아니다.
set -u
input=$(cat)

verdict=$(printf '%s' "$input" | python3 -c '
import json, re, shlex, sys

try:
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
except Exception:
    cmd = ""
if not cmd:
    print("OK"); sys.exit(0)

MODEL_TOKEN = re.compile(r"^[\x27\x22]?gpt-6\.1-sol[\x27\x22]?$")
# 값 전체 인용(-c "model_reasoning_effort=xhigh")도 허용 — 앞 인용부호 미허용은 오탐이었다(3차 [cx])
EFFORT_TOKEN = re.compile(r"^[\x27\x22]?model_reasoning_effort=[\x27\x22]?xhigh[\x27\x22]?$")
EFFORT_ANY = re.compile(r"^[\x27\x22]?model_reasoning_effort=")

def check_calls(calls):
    # 옵션은 토큰 쌍(-m 값 / -c 값)으로 검사한다 — 문자열 부분 일치는 프롬프트 본문에
    # 들어 있는 "model_reasoning_effort=xhigh" 문구를 옵션으로 오인했다(2차 [cx] 지적).
    for seg in calls:
        ok_model = any(seg[k] == "-m" and MODEL_TOKEN.match(seg[k + 1])
                       for k in range(len(seg) - 1))
        # effort는 "xhigh 지정이 하나 있다"가 아니라 "effort 지정 전부가 xhigh"여야 한다
        # — 중복 -c(…xhigh -c …high)는 마지막 값이 이겨 하향 통과였다(3차 [cx])
        effort_vals = [seg[k + 1] for k in range(len(seg) - 1)
                       if seg[k] == "-c" and EFFORT_ANY.match(seg[k + 1])]
        ok_effort = bool(effort_vals) and all(EFFORT_TOKEN.match(v) for v in effort_vals)
        if not ok_model:
            return "MODEL"
        if not ok_effort:
            return "EFFORT"
    return "OK"

def tokenize(text):
    # 줄 연속(backslash-개행)은 공백으로, 나머지 개행은 명령 구분자로 치환 —
    # 여러 줄 명령의 2번째 이후 호출 미탐(2차 [cx])과 줄 연속 호출 오탐(3차 [cx]) 방지.
    # 인용 문자열 내부의 개행도 치환되지만, 이 훅은 분석만 하고 실행하지 않으므로 무해하다.
    text = text.replace("\\\n", " ").replace("\n", " ; ")
    lex = shlex.shlex(text, posix=False, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)

try:
    tokens = tokenize(cmd)
except ValueError:
    # 인용 불일치·heredoc 등 파싱 불가 → 구식 보수 검사로 폴백:
    # 명령 위치 codex exec 이 보이면 문자열 전체에서 옵션을 요구한다.
    if re.search(r"(^|[|;&(\n])\s*codex\s+exec(\s|$)", cmd):
        print(check_calls([cmd.split()]))
    else:
        print("OK")
    sys.exit(0)

CONNECTORS = {";", "&", "&&", "|", "||", "(", ")", ";;", "|&"}
TRANSPARENT = {"if", "then", "elif", "else", "while", "until", "do", "!", "time", "sudo", "env", "command"}
ASSIGN_RE = re.compile(r"[A-Za-z_][A-Za-z_0-9]*=")

calls = []
cmd_pos = True
i = 0
while i < len(tokens):
    t = tokens[i]
    if t in CONNECTORS or "\n" in t:
        cmd_pos = True
        i += 1
        continue
    if cmd_pos:
        # 예약어·환경변수 접두·그 옵션(-i, -u user …)은 건너뛰고 명령 위치 유지
        # — env/sudo/command 의 옵션 뒤 호출 미탐 방지(2차 [cx])
        if t in TRANSPARENT or ASSIGN_RE.match(t) or t.startswith("-"):
            i += 1
            continue
        if t == "codex" and i + 1 < len(tokens) and tokens[i + 1] == "exec":
            j = i + 2
            seg = []
            while j < len(tokens) and tokens[j] not in CONNECTORS:
                seg.append(tokens[j])
                j += 1
            calls.append(seg)
            i = j
            continue
        cmd_pos = False
    i += 1

print(check_calls(calls))
' 2>/dev/null)

case "$verdict" in
  MODEL)
    echo '[Hook 차단] codex exec 는 -m gpt-6.1-sol 필수 — kty 고정 지시. 모델 교체는 사용자 승인 + 훅·SKILL.md 동시 갱신으로만. (연쇄 명령이면 모든 codex exec 호출 각각에 옵션을 명시할 것)' >&2
    exit 2 ;;
  EFFORT)
    echo '[Hook 차단] codex exec 는 -c model_reasoning_effort="xhigh" 필수 — kty 고정 지시(2026-09-27 high → xhigh), 임의 하향 금지(high 도 하향이다). 낮춰야 할 사유가 있으면 사용자에게 먼저 승인받을 것. (연쇄 명령이면 모든 codex exec 호출 각각에 옵션을 명시할 것)' >&2
    exit 2 ;;
esac
exit 0
