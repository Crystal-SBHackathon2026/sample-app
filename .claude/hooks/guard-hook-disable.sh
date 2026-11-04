#!/usr/bin/env bash
# PreToolUse(Bash): 에이전트가 게이트를 스스로 끄려 할 때 **한 번 세운다.**
#
# ── 이것은 보안 경계가 아니다. 과속방지턱이다 ────────────────────────
# 판정은 정규식 하나다. 셸을 해석하지 않으므로 **우회가 가능하고, 아래는 전부 실측이다**:
#
#   read HARNESS_HOOKS <<< off; export HARNESS_HOOKS   → 통과 (`이름=` 이 없다)
#   env 'HARNESS_HOOKS''=off' claude                   → 통과 (따옴표로 쪼갰다)
#   V=HARNESS_HOOKS; export $V=off                     → 통과 (이름이 변수 안에 있다)
#   eval · base64 · 생성한 스크립트 실행                → 통과 (패턴이 아예 안 나타난다)
#
# 그래서 이 훅을 **방벽으로 믿으면 안 된다.** 막으려는 대상이 적대적 공격자가 아니라
# **막힌 에이전트의 직진 충동**이기 때문에 값을 한다 — 게이트가 성가실 때 실제로 치는 것은
# `HARNESS_HOOKS=off ...` 라는 직진형이고, 그건 막힌다.
#
# 제대로 막으려면 명령을 셸 문법으로 파싱해야 하는데, 이 저장소는 그 늪을 이미 겪었다 —
# `harness.env` 판독기가 셸 파싱을 반쯤 하다 fail-open 6종을 만들었고 검수에서 4종이 더
# 나왔다. **셸 파서는 반쯤 만들면 안 만든 것보다 나쁘다**(막힌다고 믿게 하면서 안 막는다).
#
# ── 위양성 쪽으로 기운다 ─────────────────────────────────────────────
# 실행 구문과 인용문·데이터를 구분하지 않는다. 그래서 `git grep 'HARNESS_HOOKS=off'` 같은
# 정당한 검색도 막힌다. **의도된 선택이다** — 따옴표 안을 건너뛰면 위양성은 사라지지만
# `bash -c 'HARNESS_HOOKS=off ...'` 가 뚫린다. 둘은 문자열로 구별되지 않는 같은 모호성의
# 양면이고, 위양성은 메시지 한 번이 비용이지만 위음성은 **게이트가 꺼진 걸 아무도 모르는**
# 것이 비용이다. 형제 검사기(check-layer-boundary.sh)와 같은 판단이다.
#
# ── 탈출구가 없는 이유 ───────────────────────────────────────────────
# 환경변수 탈출구를 두면 그것으로 이 훅을 끄고 나머지를 전부 끌 수 있어 존재 이유가
# 사라진다. guard-codex-invocation 과 같은 처리다. 사용자가 정말 끄려면 셸에서 직접
# export 하고 세션을 새로 띄우거나 settings.json 배선을 지운다 — 둘 다 사람이 하는 행위다.
#
# 셸 이식성: macOS 기본 bash 는 3.2 다.

set -uo pipefail
# shellcheck source=_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

payload="$(cat)"
cmd="$(printf '%s' "$payload" | json_get tool_input.command)"
[ -z "$cmd" ] && exit 0

# 감시 대상 = 게이트를 끄는 스위치들.
# 값까지 보지 않는다 — `ECC_DISABLED_HOOKS=stop:knowledge` 처럼 **하나만** 끄는 것도
# 에이전트가 정할 일이 아니다. 무엇을 끌지는 사용자가 정한다.
#
# `이름=` 형태의 **대입**만 잡는다. 앞 문자가 영숫자·밑줄·`$` 가 아니어야 하므로
# `$ECC_DISABLED_HOOKS` 같은 참조나 `MY_ECC_GATEGUARD=` 같은 다른 이름은 안 걸린다.
matched="$(printf '%s' "$cmd" \
  | grep -oE '(^|[^A-Za-z0-9_$])(HARNESS_HOOKS|ECC_DISABLED_HOOKS|ECC_GATEGUARD)=' \
  | grep -oE '(HARNESS_HOOKS|ECC_DISABLED_HOOKS|ECC_GATEGUARD)' \
  | sort -u | tr '\n' ' ')"
[ -z "$matched" ] && exit 0

{
  echo "[차단] 게이트를 끄려 하고 있습니다: ${matched% }"
  echo
  echo "이 탈출구는 **사용자를 위한 것**이지 막힌 에이전트를 위한 것이 아닙니다."
  echo "게이트가 성가신 순간이 게이트가 일하는 순간입니다."
  echo
  echo "해야 할 일: 끄지 말고 **사용자에게 물으세요.**"
  echo "  - 무엇이 막혔는지"
  echo "  - 왜 그 게이트를 끄는 것이 옳다고 보는지"
  echo "  - 끄지 않고 갈 수 있는 길은 없는지"
  echo
  echo "**실제 대입이 아니라면**(문서 검색·문서 작성·테스트 픽스처 등) 이건 위양성입니다."
  echo "이 훅은 실행 구문과 인용문을 구분하지 않고 **위양성 쪽으로 기웁니다** — 그 편이"
  echo "게이트가 조용히 꺼지는 것보다 싸기 때문입니다. 우회하지 말고 다른 방법을 쓰세요:"
  echo "  - 검색이면 패턴을 쪼갠다:  git grep -n 'HARNESS_HOOKS' | grep -- '=off'"
  echo "  - 파일에 쓰는 것이면 Write/Edit 도구를 쓴다 (이 훅은 Bash 만 본다)"
  echo "  - 그래도 필요하면 사용자에게 위양성임을 말하고 지시를 받으세요"
  echo
  echo "참고: 이 훅은 **과속방지턱이지 방벽이 아닙니다.** 우회 경로가 있다는 것을 알고"
  echo "만들었습니다(훅 주석에 실측 목록이 있습니다). 우회하라는 뜻이 아니라, 이 훅이"
  echo "막았다고 해서 안전이 보장된 것은 아니라는 뜻입니다."
} >&2
exit 2
