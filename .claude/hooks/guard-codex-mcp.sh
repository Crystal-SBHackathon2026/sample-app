#!/usr/bin/env bash
# codex MCP 호출 규율 훅 (2026-08-11 감사 지적 (a) 반영)
# guard-codex-invocation.sh 는 matcher "Bash" 전용이라 `codex exec` CLI 경로만 봤고,
# 같은 계약(모델 gpt-6.1-sol + effort xhigh 고정, 리뷰는 read-only)을 mcp__codex__codex
# MCP 호출이 통째로 우회했다. 이 훅이 그 경로를 막는다 — settings.json 의
# matcher "mcp__codex__codex" 로 배선된다.
#
# 검사 규칙 (tool_input 기준):
#   - model: 없으면 통과 (codex config.toml 기본값이 gpt-6.1-sol).
#            있으면 정확히 gpt-6.1-sol 이어야 한다 — 아니면 차단.
#   2026-10-01 kty 지시로 gpt-5.6-sol → gpt-6.1-sol.
#   - config.model_reasoning_effort: 없으면 통과 (기본값 xhigh).
#            있으면 xhigh 만 허용 — high/medium/low 등 하향은 차단(2026-09-27 high → xhigh).
#   - sandbox: danger-full-access 면 차단 (리뷰 계약은 read-only).
#
# 이 게이트는 정직한 드리프트 방지용이지 적대 방어가 아니다 — base-instructions
# 교체(리뷰 지시문 자체를 바꿔치기)는 검사하지 않는다(기록된 한계).
# 변경이 필요하면 이 훅과 하네스 SKILL.md를 함께 고친다 — 사용자 승인 필수.
set -u
input=$(cat)

verdict=$(printf '%s' "$input" | python3 -c '
import json, sys

try:
    ti = json.load(sys.stdin).get("tool_input", {})
except Exception:
    ti = {}
if not isinstance(ti, dict):
    ti = {}

# 모델: 부재는 통과(config.toml 기본값). 존재하면 정확 일치만 — 문자열이 아닌
# 값(형식 밖)도 "gpt-6.1-sol 이 아니다"이므로 같은 차단으로 접는다.
model = ti.get("model")
if model is not None and model != "gpt-6.1-sol":
    print("MODEL"); sys.exit(0)

# effort: 부재는 통과(기본값 xhigh). 존재하면 xhigh 만.
# config 중첩 override 도 같은 계약을 받는다 — [cx] 지적: config.model /
# config.sandbox_mode 로 top-level 검사를 우회할 수 있었다.
config = ti.get("config")
if isinstance(config, dict):
    effort = config.get("model_reasoning_effort")
    if effort is not None and effort != "xhigh":
        print("EFFORT"); sys.exit(0)
    cfg_model = config.get("model")
    if cfg_model is not None and cfg_model != "gpt-6.1-sol":
        print("MODEL"); sys.exit(0)
    if config.get("sandbox_mode") == "danger-full-access":
        print("SANDBOX"); sys.exit(0)

if ti.get("sandbox") == "danger-full-access":
    print("SANDBOX"); sys.exit(0)

print("OK")
' 2>/dev/null)

case "$verdict" in
  MODEL)
    echo '[Hook 차단] mcp__codex__codex 의 model 은 gpt-6.1-sol 만 허용 — kty 고정 지시. 허용 값: model 생략(config.toml 기본값) 또는 "gpt-6.1-sol". 모델 교체는 사용자 승인 + 훅·SKILL.md 동시 갱신으로만.' >&2
    exit 2 ;;
  EFFORT)
    echo '[Hook 차단] mcp__codex__codex 의 config.model_reasoning_effort 는 xhigh 만 허용 — kty 고정 지시, 임의 하향 금지(high 도 하향이다). 허용 값: 키 생략(기본값 xhigh) 또는 "xhigh". 낮춰야 할 사유가 있으면 사용자에게 먼저 승인받을 것.' >&2
    exit 2 ;;
  SANDBOX)
    echo '[Hook 차단] mcp__codex__codex 의 sandbox=danger-full-access 는 금지 — 리뷰 계약은 read-only 다. 허용 값: sandbox 생략 또는 "read-only"(리뷰 용도), 쓰기가 꼭 필요하면 "workspace-write" 를 사용자 승인 후에.' >&2
    exit 2 ;;
esac
exit 0
