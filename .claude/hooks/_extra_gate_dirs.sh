#!/usr/bin/env bash
#
# 추가 관할 폴더 슬롯(HARNESS_EXTRA_GATE_DIRS) 계약 모듈 — ADR-0026. source 전용.
#
# 바뀌는 이유는 하나다: 슬롯이 무엇을 관할하고, 그 의무를 어디서 리뷰로 푸는가.
# 리뷰 자리 기록 형식의 **유일한 정본**이 이 파일이다. 쓰기(record_*)와 읽기(read_*)가
# 함께 있고, 훅들은 형식을 모른 채 rc·사유 코드·접두 줄만 안다.
#
# 키 판독 상태(extra_gate_key_state)와 사유 문구(extra_problem_text)는 _common.sh 에
# 있다 — 이 모듈이 유실돼도 그 사실을 알려야 하기 때문이다.
#
# set -u 안전 계약: 이 모듈의 전역은 아래에서 기본값을 받고, _common.sh 의 전역
# (DUALREVIEW_FLAG·REVIEW_DIRS_FILE)은 `${X:-}` 로만 읽는다. 홈 디렉터리는
# expand_home_path 의 머리 주석과 본문에서만 읽는다(시험 x01).
# 셸 이식성: macOS 기본 bash 는 3.2 다. ${var,,}·mapfile·연관배열 금지.
#
# ── 기록 형식 (정본) ──────────────────────────────────────────────────
#   한 줄 = 값 US 꼬리 LF    (US = 0x1F. 값 = 듀얼리뷰 플래그의 절대경로 그대로)
#   꼬리는 셋 중 하나다.
#     -              빈 집합 — 세션 루트 규칙(세션 루트 _workspace 의 리뷰로 푼다)
#     !              갱신 표시 — 이 값의 의무 갱신이 시작됐고 현재 기록이 아직 없다
#     /d1[US/d2]...  리뷰 자리 — 그중 한 곳의 새 *codex*.md 로 푼다
#   값마다 **마지막 줄**이 현재다. 덧붙이기만 한다(대체 쓰기·잠금 없음).
#   맨 `값`(꼬리 없음)은 쓰지 않는다.
#   읽을 때 꼬리가 위 셋이 아니면 모르는 꼴이고, 그 값은 missing-record 다 — 꼬리
#   없음 · 빈 필드 · `/` 로 시작하지 않는 필드 · `-`·`!` 가 섞인 꼬리.
#   파일이 비어 있지 않은데 마지막 바이트가 개행이 아니면 마지막 줄을 모르는 꼴로
#   본다(덧붙이기가 중간에 잘렸다).
#
# ── 수명 계약 ─────────────────────────────────────────────────────────
#   슬롯이 켜진 판정이 값 v 의 듀얼리뷰 의무를 쓰면(새 줄이든 touch 든) 한 판정
#   안에서 이 순서를 지킨다.
#     ① record_review_pending v  ② 듀얼리뷰 플래그 갱신  ③ record_review_dirs v 자리...
#   ③ 만 실패하면 마지막 줄이 갱신 표시로 남아 해제가 막힌다 — ③ 만 실패하는 경로는
#   막힌다. ①·③ 이 둘 다 일시 장애로 실패했다가 Stop 전에 회복되면 옛 줄이 현재로
#   남는다(공시). 지속 장애(권한·파일 종류)는 read_review_verdict 의 사용 가능성
#   검사가 막는다. 그 검사에서 결과를 바꾸는 것은 쓰기 가능(-w)과 일반 파일(-f)이다 —
#   -f 가 없으면 폴더는 macOS awk 가 빈 입력으로 읽어(rc 0. mawk 는 rc 2 로 평가 실패)
#   기록 0줄이 되고, 그러면 슬롯을 모르는 평가(dir-unknown)에서 기록 없는 절대 항목이
#   세션 루트 규칙으로 풀린다. FIFO 는 판독기가 끝없이 기다린다. 읽기(-r)는 사유 문구를
#   정밀화하는 용도다 — 없으면 판독이 실패해 어차피 평가 실패로 막힌다.
#   기록 한 줄은 1023바이트(개행 포함 1024)를 넘지 않는다 — bash 3.2 의 printf 는 그보다
#   긴 줄을 1024바이트씩 나눠 써서, 병렬 덧붙이기가 그 사이에 끼면 줄이 섞여 다른 값·자리로
#   읽힌다. 넘는 줄은 쓰지 않는다(rc 2 영구) — ③ 이 그렇게 빠지면 끝줄이 갱신 표시로 남아
#   막히고, ① 까지 빠지면 기록 없는 슬롯 항목으로 막힌다.

EXTRA_GATE_DIR=''          # 켜졌을 때 슬롯의 물리 절대경로(validate_extra_gate_dir)
EXTRA_GATE_PROBLEM=''      # 불량 사유: colon|tilde|relative|missing|newline|root
REVIEW_RECORD_SEP=$'\037'  # 기록 형식의 필드 구분자(US)
REVIEW_RECORD_MAX=1023    # 기록 한 줄의 최대 바이트(개행 제외 — 한 번의 write 로 나가는 길이)
REVIEW_VERDICT_REASONS=''  # read_review_verdict 가 쌓는 사유 코드(공백 구분)
REVIEW_VERDICT_LINES=()    # read_review_verdict 가 쌓는 W·M 줄(배열 — 중복은 낼 때 지운다)
SAME_DIR_PREFIX=''         # find_same_dir_prefix 가 찾은 접두

# 기록 형식의 판독기. 쓰기 쪽 계약(위 머리 주석)과 한 파일에 둔다. 경로는 awk 피연산자로만
# 넘긴다 — `-v` 로 넘기면 백슬래시가 이스케이프로 해석된다.
#   mode=verdict  ARGV[1] 기록 · ARGV[2] 듀얼리뷰 플래그. 플래그 항목마다 한 줄:
#                 S␟값 세션 루트 규칙 · D␟자리[␟자리] · P␟값 missing-record ·
#                 N␟값 기록 없는 절대 항목(소속 판정은 셸이 is_slot_entry 로 한다)
#   mode=dirs     ARGV[1] 기록. 자리 줄의 자리를 중복 없이 한 줄에 하나씩
#   torn=1        마지막 줄이 잘렸다(셸이 판정해 정수로만 넘긴다)
# 파일 구분은 FILENAME==ARGV[1] 이다. NR==FNR 은 기록 파일이 비면 플래그 줄을 기록으로
# 읽는다.
REVIEW_RECORD_AWK='
BEGIN { US = sprintf("%c", 31) }
function key_of(s,   i) { i = index(s, US); return i ? substr(s, 1, i - 1) : s }
function tail_of(s,   i) { i = index(s, US); return i ? substr(s, i + 1) : "" }
function is_dirs(t,   n, a, k) {
  n = split(t, a, US)
  if (n < 1) return 0
  for (k = 1; k <= n; k++) if (substr(a[k], 1, 1) != "/") return 0
  return 1
}
function emit_dirs(s,   t, n, a, k) {
  t = tail_of(s)
  if (!is_dirs(t)) return
  n = split(t, a, US)
  for (k = 1; k <= n; k++) if (!(a[k] in out)) { out[a[k]] = 1; print a[k] }
}
mode == "dirs" { if (NR > 1) emit_dirs(held); held = $0; next }
mode == "verdict" && FILENAME == ARGV[1] {
  k = key_of($0); last[k] = tail_of($0); prev = k; next
}
mode == "verdict" {
  if (!flags++ && torn) last[prev] = "?"
  v = $0
  if (v == "") next
  if (!(v in last)) {
    kind = substr(v, 1, 1) == "/" ? "N" : "S"
    print kind US v
    next
  }
  t = last[v]
  if (t == "-") print "S" US v
  else if (is_dirs(t)) print "D" US t
  else print "P" US v
}
END { if (mode == "dirs" && NR > 0 && !torn) emit_dirs(held) }
'

# --- 설정 · 소속 -----------------------------------------------------------

#######################################
# 슬롯 원문 값을 검증해 물리 절대경로로 확정한다. 값을 실행하지 않는다.
# Globals:
#   EXTRA_GATE_DIR, EXTRA_GATE_PROBLEM (씀)
# Arguments:
#   $1 — harness.env 에서 판독된 원문 값
# 경로는 센티널(`x`)을 붙여 받는다 — 명령 치환은 후행 개행을 전부 지워, 개행으로
# 끝나는 폴더가 이름이 같은 다른 폴더로 바뀐다(check-harness-env 의 관용구와 같다).
# 개행이 든 경로는 줄 단위 기록에 쓸 수 없어 거부한다.
# Returns:
#   0 정상 · 1 불량(EXTRA_GATE_PROBLEM =
#   colon|tilde|relative|missing|newline|root)
#######################################
validate_extra_gate_dir() {
  local raw="${1:-}" path phys
  EXTRA_GATE_DIR=''
  EXTRA_GATE_PROBLEM=''
  case "$raw" in
    *:*) EXTRA_GATE_PROBLEM='colon'; return 1 ;;
    '~'*)
      path="$(expand_home_path "$raw" && printf x)"
      if [[ "$path" != *x ]]; then
        EXTRA_GATE_PROBLEM='tilde'
        return 1
      fi
      path="${path%x}"
      path="${path%$'\n'}" ;;
    /*) path="$raw" ;;
    *) EXTRA_GATE_PROBLEM='relative'; return 1 ;;
  esac
  phys="$(CDPATH='' cd -P -- "$path" 2>/dev/null && pwd -P && printf x)"
  if [[ "$phys" != *x ]]; then
    EXTRA_GATE_PROBLEM='missing'
    return 1
  fi
  phys="${phys%x}"
  phys="${phys%$'\n'}"
  case "$phys" in
    *$'\n'*) EXTRA_GATE_PROBLEM='newline'; return 1 ;;
  esac
  # `//` 도 루트다 — `pwd -P` 는 값 `//` 를 `//` 그대로 낸다(POSIX 가 허용하는 표기).
  if [[ "$phys" == '/' || "$phys" == '//' ]]; then
    EXTRA_GATE_PROBLEM='root'
    return 1
  fi
  EXTRA_GATE_DIR="$phys"
}

#######################################
# 홈 기준 토큰을 펼친다 — `~` · `~/…` · `$HOME` · `$HOME/…` · `${HOME}` · `${HOME}/…`.
# 이 모듈에서 홈 디렉터리를 읽는 유일한 자리다. `${HOME:-}` 로 읽어 set -u 에서
# 미설정이어도 죽지 않는다.
# Globals:
#   HOME (읽음)
# Arguments:
#   $1 — 토큰
# Outputs:
#   펼친 경로 한 줄. 개행을 품지 않는다 — 품으면 받는 쪽의 명령 치환이 끝 개행을
#   지워 다른 경로가 되므로 내지 않는다.
# Returns:
#   0 펼침 · 1 펼칠 수 없음(`~사용자`, 홈이 비었거나 절대경로가 아님, 결과에 개행) ·
#   2 홈 기준 토큰이 아님
#######################################
expand_home_path() {
  local tok="${1:-}" home="${HOME:-}" rest out
  case "$tok" in
    '~' | '~/'*) rest="${tok:1}" ;;
    '~'*) return 1 ;;
    '$HOME' | '$HOME/'*) rest="${tok:5}" ;;
    '${HOME}' | '${HOME}/'*) rest="${tok:7}" ;;
    *) return 2 ;;
  esac
  [[ "$home" == /* ]] || return 1
  out="${home%/}$rest"
  case "$out" in
    *$'\n'*) return 1 ;;
  esac
  printf '%s\n' "${out:-/}"
}

#######################################
# 경로 자신이나 그 조상(문자열로 한 성분씩 거슬러 오름) 가운데 폴더 $2 와 같은 폴더
# (-ef — 같은 inode)를 찾는다. 소속 판정의 유일한 비교다. 문자열 접두로 비교하면
# 대소문자·유니코드 정규화를 무시하는 볼륨에서 틀린다 — `pwd -P` 는 입력한 표기를,
# git 은 디스크 표기를 돌려준다. 없는 성분(지워진 경로)은 건너뛴다.
# Globals:
#   SAME_DIR_PREFIX (씀 — 찾은 접두, 입력 표기 그대로)
# Arguments:
#   $1 — 경로, $2 — 폴더
# Returns:
#   0 찾음 · 1 없음(인자 빈 값 포함)
#######################################
find_same_dir_prefix() {
  local p="${1:-}" d="${2:-}"
  SAME_DIR_PREFIX=''
  [[ -n "$p" && -n "$d" ]] || return 1
  while [[ -n "$p" ]]; do
    if [[ "$p" -ef "$d" ]]; then
      SAME_DIR_PREFIX="$p"
      return 0
    fi
    [[ "$p" == */* ]] || return 1
    p="${p%/*}"
  done
  return 1
}

#######################################
# 경로가 슬롯과 같거나 그 아래인가(같은 폴더 판정 — 표기와 무관).
# Globals:
#   EXTRA_GATE_DIR (읽음) · SAME_DIR_PREFIX (find_same_dir_prefix 가 씀)
# Arguments:
#   $1 — 물리 절대경로
# Returns:
#   0 안 · 1 밖, 또는 슬롯이 비었다(켜지지 않음)
#######################################
in_extra_gate_dir() {
  [[ -n "${EXTRA_GATE_DIR:-}" ]] || return 1
  find_same_dir_prefix "${1:-}" "$EXTRA_GATE_DIR"
}

#######################################
# 플래그 값이 슬롯 항목인가 — 절대경로 ∧ 세션 루트 밖 ∧ 슬롯 안(둘 다 같은 폴더 판정).
# 판정자(자리 계산)와 Stop(기록 없는 절대 항목의 누락 검사)이 함께 쓰는 유일한
# 소속 술어다.
# Globals:
#   EXTRA_GATE_DIR (in_extra_gate_dir 이 읽음) · SAME_DIR_PREFIX (씀)
# Arguments:
#   $1 — 플래그 값, $2 — 물리 세션 루트(비면 판정하지 않는다)
# Returns:
#   0 슬롯 항목 · 1 아님
#######################################
is_slot_entry() {
  local v="${1:-}" root="${2:-}"
  [[ "$v" == /* && -n "$root" ]] || return 1
  find_same_dir_prefix "$v" "$root" && return 1
  in_extra_gate_dir "$v"
}

#######################################
# 설계·계획 산출물 모양인가 — 부모 폴더 이름이 _workspace 또는 _workspace_*, 파일
# 이름이 NN_design*.md 또는 NN_plan*.md. 대소문자는 가리지 않는다(기존 설계 글롭과
# 같다). nocasematch 는 원래 상태로 되돌린다.
# Arguments:
#   $1 — 물리 절대경로
# Returns:
#   0 · 1
#######################################
is_design_shaped() {
  local p="${1:-}" name parent was_set=0 rc=1
  name="${p##*/}"
  parent="${p%/*}"
  parent="${parent##*/}"
  shopt -q nocasematch && was_set=1
  shopt -s nocasematch
  case "$parent" in
    _workspace | _workspace_*)
      case "$name" in
        [0-9][0-9]_design*.md | [0-9][0-9]_plan*.md) rc=0 ;;
      esac ;;
  esac
  ((was_set)) || shopt -u nocasematch
  return "$rc"
}

#######################################
# 형제 규칙 ① — 저장소 최상위 T 옆의 작업 공간 `<T 부모>/_workspace_<T 이름>`.
# 개행이 든 입력은 거부한다(출력이 받는 쪽 명령 치환에서 다른 경로가 된다).
# Arguments:
#   $1 — 저장소 최상위(물리 절대경로, `/` 아님)
# Outputs:
#   작업 공간 경로 한 줄
# Returns:
#   0 · 1 절대경로가 아니거나 `/` 이거나 개행을 품음
#######################################
sibling_workspace_of() {
  local t="${1:-}"
  [[ "$t" == /?* && "$t" != *$'\n'* ]] || return 1
  printf '%s/_workspace_%s\n' "${t%/*}" "${t##*/}"
}

#######################################
# 형제 규칙 ② — 작업 공간 W(`_workspace_<n>`) 옆의 저장소 `<W 부모>/<n>`.
# 개행이 든 입력은 거부한다(형제 규칙 ①과 같은 이유).
# Arguments:
#   $1 — 작업 공간(물리 절대경로)
# Outputs:
#   저장소 경로 한 줄
# Returns:
#   0 · 1 절대경로가 아니거나 개행을 품거나 이름이 `_workspace_<비지 않은 n>` 이
#   아님
#######################################
sibling_repo_of() {
  local w="${1:-}" name
  [[ "$w" == /* && "$w" != *$'\n'* ]] || return 1
  name="${w##*/}"
  case "$name" in
    _workspace_?*) printf '%s/%s\n' "${w%/*}" "${name#_workspace_}" ;;
    *) return 1 ;;
  esac
}

#######################################
# 명령문의 홈 기준 토큰을 펼쳐 낸다(Bash 스윕의 탐색 힌트 — 명령 해석이 아니다).
# 후보는 `$` 로 시작하는 낱말과, **단어 머리**의 `~` 로 시작하는 낱말이다. 단어 머리는
# 줄 처음이거나 공백·탭·`=`·`:`·`(`·`;`·`|`·`&`·`<`·`>` 바로 뒤다 — 셸이 `~` 를 펼칠
# 수 있는 자리다. `HEAD~1` · `x@~4` 같은 단어 중간 `~` 와, 따옴표 바로 뒤의 `~`
# (`'~ok'` · `"~1.2.3"` — 셸은 따옴표 안의 `~` 를 펼치지 않는다)는 후보가 아니다.
# 따옴표 상태는 따지지 않는다 — 따옴표 안 공백 뒤의 `~단어` 도 후보가 되지만, 아래
# 사용자 확인이 거짓 알림을 거른다(셸은 따옴표 안의 `~/x` 도 펼치지 않는데 여기서는
# 펼쳐 훑는다 — 더 훑을 뿐이다).
# 단서: 셸은 중괄호 확장(`{~/a,~/b}`) 안의 `~` 도 펼치지만 여기서는 후보가 아니다(`{` ·
# `,` 뒤라 단어 머리가 아니다) — 그 경로는 훑지 못한다(드문 꼴, 공시).
# 토큰은 공백·탭·`:`·셸 메타문자(`;|&<>()` · 백틱)·따옴표가 아닌 바이트를 끝까지
# 읽는다 — 비ASCII 경로(`~/work/트랙/T/src/a.go`)도 중간에서 끊지 않는다. `:` 는
# 이음 문자가 아니라 경계이자 다음 토큰의 머리다(`-v ~/slot/T:/w` 의 `~/slot/T` ·
# `X=~/a:~/b` 의 `~/b`).
# 홈 기준인지는 expand_home_path 가 가른다.
# 후보 추출기(awk)는 끝에 표지 줄 `.` 을 낸다(후보는 `~`·`$` 로 시작해 겹치지
# 않는다). 표지가 없으면 추출이 실패한 것이다 — 빈 출력 + rc 0 으로 숨기지 않는다.
# 순회는 매개변수 확장으로 한다(임시 파일·프로세스 치환 없음).
# 홈 기준인데 펼칠 수 없는 토큰(있는 사용자의 `~사용자` · `~+` · `~-` · 홈 경로 모름)이
# 있으면 rc 3 으로 알린다 — 그 토큰이 가리킨 곳을 훑지 못한 것이다. 없는 사용자의
# `~사용자`(`"perf: ~2x"` · `~~~` · `a.b=~4.17.21`)는 셸도 펼치지 않아 글자 그대로 남고
# 그 경로는 cwd 스윕이 덮으므로 알리지 않는다(login_names_exist). 펼친 나머지는 낸다.
# Arguments:
#   $1 — 명령문
# Outputs:
#   펼친 절대경로, 한 줄에 하나
# Returns:
#   0 · 2 후보 추출 실패(출력 없음) · 3 펼치지 못한 홈 토큰이 있음(나머지는 냈다)
#######################################
home_path_tokens() {
  local toks tok name users='' nl=$'\n' partial=0
  toks="$(printf '%s\n' "${1:-}" | LC_ALL=C awk -v heads=$' \t=:(;|&<>' '
    {
      s = $0
      prev = ""
      while (match(s, "[~$][^ \t:;|&<>()`\"\047]*")) {
        t = substr(s, RSTART, RLENGTH)
        c = RSTART > 1 ? substr(s, RSTART - 1, 1) : prev
        if ((substr(t, 1, 1) != "~" || c == "" || index(heads, c)) && !(t in seen)) {
          seen[t] = 1
          print t
        }
        prev = substr(t, RLENGTH, 1)
        s = substr(s, RSTART + RLENGTH)
      }
    }
    END { print "." }' 2>/dev/null)"
  [[ "$toks" == '.' || "$toks" == *"$nl." ]] || return 2
  toks="${toks%.}"
  while [[ -n "$toks" ]]; do
    tok="${toks%%"$nl"*}"
    toks="${toks#*"$nl"}"
    [[ -n "$tok" ]] || continue
    expand_home_path "$tok"
    [[ $? -eq 1 ]] || continue
    case "$tok" in
      '~+' | '~+/'* | '~-' | '~-/'*) partial=1 ;;  # 셸이 cwd · 이전 cwd 로 펼친다
      '~'[!/]*) name="${tok:1}"; users="$users${name%%/*}$nl" ;;
      *) partial=1 ;;
    esac
  done
  [[ -n "$users" ]] && login_names_exist "$users" && partial=1
  ((partial)) && return 3
  return 0
}

#######################################
# `~사용자` 토큰의 사용자 가운데 이 기기에 있는 이가 있는가 — 셸은 있는 사용자의 홈만
# 펼친다. 이름은 셸 사용자 이름 문자(영숫자 · `_` 로 시작, 이어서 `.` `_` `@` `-`)만
# 받는다. 조회는 getpwnam(python3 pwd) 한 번이고 이름을 인자가 아닌 stdin 으로 넘긴다 —
# 입력을 실행하지 않는다(eval 없음). 조회를 못 하면(python3 없음 등) 있다고 본다(알리는 쪽).
# Arguments:
#   $1 — 사용자 이름(LF 줄 목록)
# Returns:
#   0 있음 · 조회 불가 · 1 없음(이름 문자 밖 포함)
#######################################
login_names_exist() {
  local rest="${1:-}" name names='' re='^[A-Za-z0-9_][A-Za-z0-9._@-]*$' LC_ALL=C
  while [[ -n "$rest" ]]; do
    name="${rest%%$'\n'*}"
    case "$rest" in *$'\n'*) rest="${rest#*$'\n'}" ;; *) rest='' ;; esac
    [[ "$name" =~ $re ]] && names="$names$name"$'\n'
  done
  [[ -n "$names" ]] || return 1
  printf '%s' "$names" | python3 -c 'import pwd, sys
for name in sys.stdin.read().split("\n"):
    try:
        if name:
            pwd.getpwnam(name)
            sys.exit(0)
    except KeyError:
        pass
sys.exit(3)' 2>/dev/null
  [[ $? -ne 3 ]]
}

# --- 쓰기 -----------------------------------------------------------------

#######################################
# 기록에 넣을 수 없는 바이트(US·LF)가 있는가 — 넣으면 형식이 깨진다.
# Globals:
#   REVIEW_RECORD_SEP (읽음)
# Arguments:
#   $1 — 값 또는 자리
# Returns:
#   0 있음 · 1 없음
#######################################
has_record_separator() {
  case "${1:-}" in
    *"$REVIEW_RECORD_SEP"* | *$'\n'*) return 0 ;;
  esac
  return 1
}

#######################################
# 기록 한 줄을 덧붙인다 — 기록 파일에 쓰는 유일한 자리. 줄은 한 번의 write 로 나가야
# 병렬 덧붙이기와 섞이지 않으므로 1023바이트를 넘는 줄은 쓰지 않는다(머리 주석).
# 기록 파일이 있는데 일반 파일이 아니면(FIFO · 폴더) 쓰지 않는다 — FIFO 는 열기에서 읽는
# 쪽을 기다려 훅 상한에 닿는다. 판독기(read_review_*)의 `-f` 와 같은 기준이다.
# Globals:
#   REVIEW_DIRS_FILE, REVIEW_RECORD_MAX (읽음)
# Arguments:
#   $1 — 줄(개행 없음)
# Returns:
#   0 · 1 쓰기 실패(기록 경로 미설정 · 일반 파일 아님 포함) · 2 줄이 1023바이트를 넘음(영구)
#######################################
append_review_record() {
  local f="${REVIEW_DIRS_FILE:-}" line="${1:-}" LC_ALL=C
  [[ -n "$f" ]] || return 1
  ((${#line} <= REVIEW_RECORD_MAX)) || return 2
  [[ -e "$f" && ! -f "$f" ]] && return 1
  # 중괄호가 필요하다: 리다이렉트 열기 실패는 뒤에 붙인 2>/dev/null 보다 먼저 보고된다.
  { printf '%s\n' "$line" >> "$f"; } 2>/dev/null && return 0
  # bash 3.2 의 printf 는 쓰기 실패(EFBIG 등) 때 그 줄을 출력 버퍼에 남겨 다음 stdout
  # 출력과 함께 낸다 — 훅 stdout(JSON 한 줄)으로 새지 않게 버퍼를 /dev/null 로 비운다.
  echo >/dev/null 2>&1
  return 1
}

#######################################
# 수명 계약 ① — 갱신 표시 줄 `값␟!` 를 덧붙인다(의무 갱신보다 먼저).
# Globals:
#   REVIEW_DIRS_FILE (append_review_record 가 읽음)
# Arguments:
#   $1 — 플래그 값
# Returns:
#   0 · 1 쓰기 실패 · 2 값에 US·LF 이거나 줄이 너무 김(영구 기록 불가 — 쓰지 않는다)
#######################################
record_review_pending() {
  local v="${1:-}"
  has_record_separator "$v" && return 2
  append_review_record "$v$REVIEW_RECORD_SEP!"
}

#######################################
# 수명 계약 ③ — 현재 기록 줄을 덧붙인다(의무 갱신 뒤). 자리가 없으면 빈 집합 표지
# `값␟-` 를 쓴다 — 맨 `값` 은 쓰지 않는다. 자리는 절대경로여야 한다(아니면 읽기가
# 모르는 꼴로 보고 막는다).
# Globals:
#   REVIEW_DIRS_FILE (append_review_record 가 읽음)
# Arguments:
#   $1 — 플래그 값, $2... — 리뷰 자리
# Returns:
#   0 · 1 쓰기 실패 · 2 값이나 자리에 US·LF 이거나 줄이 너무 김(쓰지 않는다)
#######################################
record_review_dirs() {
  local v="${1:-}" line d
  has_record_separator "$v" && return 2
  (($# > 0)) && shift
  if (($# == 0)); then
    append_review_record "$v$REVIEW_RECORD_SEP-"
    return
  fi
  line="$v"
  for d in "$@"; do
    has_record_separator "$d" && return 2
    line="$line$REVIEW_RECORD_SEP$d"
  done
  append_review_record "$line"
}

# --- 읽기 -----------------------------------------------------------------

#######################################
# 기록 파일의 마지막 줄이 잘렸는가 — 비어 있지 않은데 마지막 바이트가 개행이 아니다.
# Arguments:
#   $1 — 기록 파일(awk 피연산자로 안전한 경로)
# Returns:
#   0 잘림 · 1 아님(빈 파일 포함)
#######################################
record_is_torn() {
  local last
  [[ -s "${1:-}" ]] || return 1
  last="$(tail -c 1 "$1" 2>/dev/null; printf x)"
  [[ "$last" != $'\n'x ]]
}

#######################################
# 기록 형식 판독기(REVIEW_RECORD_AWK)를 돌린다. 경로가 `-`·`이름=값` 처럼 awk 가
# 다르게 읽는 꼴이 되지 않게 상대경로에는 `./` 를 붙인다. 실패는 rc 로만 알린다
# (호출자가 평가 실패로 처리한다).
# Globals:
#   REVIEW_RECORD_AWK (읽음)
# Arguments:
#   $1 — verdict|dirs, $2 — 기록 파일, $3 — 듀얼리뷰 플래그(verdict 일 때)
# Outputs:
#   REVIEW_RECORD_AWK 머리 주석의 줄들
# Returns:
#   0 · 그 밖 판독 실패(인자 누락 포함)
#######################################
run_review_record_awk() {
  local mode="${1:-}" rec="${2:-}" flag="${3:-}" torn=0
  [[ -n "$rec" ]] || return 2
  case "$rec" in /*) ;; *) rec="./$rec" ;; esac
  record_is_torn "$rec" && torn=1
  if [[ "$mode" == dirs ]]; then
    LC_ALL=C awk -v mode=dirs -v torn="$torn" "$REVIEW_RECORD_AWK" "$rec" \
      2>/dev/null
    return
  fi
  [[ "$mode" == verdict && -n "$flag" ]] || return 2
  case "$flag" in /*) ;; *) flag="./$flag" ;; esac
  LC_ALL=C awk -v mode=verdict -v torn="$torn" "$REVIEW_RECORD_AWK" \
    "$rec" "$flag" 2>/dev/null
}

#######################################
# 발행 가드 ② 용 — 기록된 모든 자리(중복 제거, 갱신 표시·빈 집합·모르는 꼴 제외).
# Globals:
#   REVIEW_DIRS_FILE (읽음)
# Outputs:
#   자리, 한 줄에 하나
# Returns:
#   0(기록 파일 없음 포함) · 4 기록 파일이 일반 파일이 아니거나 읽을 수 없음 ·
#   2 기록 경로 미설정·판독 실패
#######################################
read_review_dirs() {
  local f="${REVIEW_DIRS_FILE:-}"
  [[ -n "$f" ]] || return 2
  [[ -e "$f" || -L "$f" ]] || return 0
  [[ -f "$f" && -r "$f" ]] || return 4
  run_review_record_awk dirs "$f" || return 2
}

#######################################
# 듀얼리뷰 의무의 해제 판정. 플래그 항목마다 그 값의 마지막 기록 줄로 본다.
#   자리 줄 → 자리 중 한 곳에 플래그보다 새, 비지 않은 일반 파일 *codex*.md
#   빈 집합 줄 · 기록 없는 상대 항목 → 세션 루트 _workspace 의 같은 조건
#   갱신 표시 줄 · 모르는 꼴 → 미충족, missing-record
#   기록 없는 절대 항목 → 슬롯을 알고 is_slot_entry 이면 missing-record(값에 US 면
#     unrecordable), 아니면 세션 루트 규칙(슬롯을 모르면 사유 dir-unknown 을 붙인다)
# 기록 파일이 없으면 0줄로 평가한다. 있으면 일반 파일·읽기·쓰기가 가능해야 한다.
# Globals:
#   DUALREVIEW_FLAG, REVIEW_DIRS_FILE, EXTRA_GATE_DIR (읽음)
#   REVIEW_VERDICT_REASONS, REVIEW_VERDICT_LINES (씀)
# Arguments:
#   $1 — 물리 세션 루트
# Outputs:
#   첫 줄 = 사유 코드(공백 구분, 없으면 빈 줄). 다음 줄부터 `W <자리>`(미충족
#   항목이 기다리는 자리)와 `M <값>`(현재 기록이 없는 값)
# Returns:
#   0 전부 충족 · 3 미충족 · 4 판정 불가(record-unusable · root-unusable) ·
#   5 환경 장애로 평가 실패(판독기 awk 실패 · 히어독 임시 파일을 만들거나 쓰지 못함 —
#   이 모듈을 다시 설치해도 풀리지 않는다) · 그 밖(2 인자 누락 — 훅과 판이 맞지 않음)
#   평가 실패. 셸이 신호로 죽으면(파일 크기 한도 아래 히어독 쓰기의 SIGXFSZ 등) rc 를
#   내지 못한다 — 서브셸로 부른 쪽이 128+신호로 받는다.
#######################################
read_review_verdict() {
  local root="${1:-}" flag="${DUALREVIEW_FLAG:-}" rec="${REVIEW_DIRS_FILE:-}"
  local rows
  [[ -n "$root" && -n "$flag" && -n "$rec" ]] || return 2
  # 세션 루트 자리(`루트/_workspace`)는 US 구분 자리 목록·줄 단위 결과에 실린다 — 루트에
  # US·LF 가 있으면 다른 폴더로 쪼개지므로 판정하지 않고 막는다(조용한 축소 금지).
  if has_record_separator "$root"; then
    printf 'root-unusable\n'
    return 4
  fi
  if [[ -e "$rec" || -L "$rec" ]]; then
    if [[ ! -f "$rec" || ! -r "$rec" || ! -w "$rec" ]]; then
      printf 'record-unusable\n'
      return 4
    fi
  else
    rec=/dev/null
  fi
  if [[ ! -e "$flag" ]]; then
    printf '\n'
    return 0
  fi
  rows="$(run_review_record_awk verdict "$rec" "$flag")" || return 5
  judge_review_rows "$root" "$rows"
}

#######################################
# 판독기 줄들로 항목별 충족을 가리고 결과를 낸다(read_review_verdict 의 뒷단).
# 입력 끝에 표지 줄(`.` — 판독기 줄은 늘 US 를 품으므로 겹치지 않는다)을 붙이고,
# 그 표지를 읽어야 끝까지 읽은 것으로 친다. 히어독은 임시 파일일 수 있다(bash 3.2
# 는 늘, 5.1 이상은 큰 입력일 때). 그 파일을 못 만들면 루프가 한 번도 돌지 않는데,
# 그대로 두면 "미충족 0개 = 전부 충족"으로 샌다.
# Globals:
#   REVIEW_RECORD_SEP (읽음) · REVIEW_VERDICT_REASONS, REVIEW_VERDICT_LINES (씀)
# Arguments:
#   $1 — 물리 세션 루트, $2 — 판독기 줄(LF 구분)
# Outputs:
#   read_review_verdict 와 같다(rc 5 이면 없음)
# Returns:
#   0 전부 충족 · 3 미충족 · 5 입력을 끝까지 읽지 못함(히어독 임시 파일 — 환경 장애)
#######################################
judge_review_rows() {
  local root="${1:-}" line unmet=0 complete=0 lines
  REVIEW_VERDICT_REASONS=''
  REVIEW_VERDICT_LINES=()
  while IFS= read -r line; do
    if [[ "$line" == '.' ]]; then
      complete=1
      continue
    fi
    [[ -n "$line" ]] || continue
    review_item_met "${line%%"$REVIEW_RECORD_SEP"*}" \
      "${line#*"$REVIEW_RECORD_SEP"}" "$root" || unmet=1
  done <<EOF
${2:-}
.
EOF
  ((complete)) || return 5
  printf '%s\n' "$REVIEW_VERDICT_REASONS"
  # 줄의 중복은 쌓을 때가 아니라 여기서 한 번에 지운다(처음 나온 순서 그대로). 쌓을
  # 때마다 앞 줄 전체와 견주면 비용이 미충족 항목 수의 제곱으로 는다. 나열만 바뀌고
  # 판정(rc)은 바뀌지 않는다. 중복 제거가 실패하면(awk 없음 · 자원 부족) 중복 제거 없는
  # 목록을 그대로 낸다 — 목록이 비면 막음 안내가 기다리는 자리를 말하지 못한다.
  if ((${#REVIEW_VERDICT_LINES[@]} > 0)); then
    if ! lines="$(printf '%s\n' "${REVIEW_VERDICT_LINES[@]}" \
        | LC_ALL=C awk '!seen[$0]++')"; then
      lines="$(printf '%s\n' "${REVIEW_VERDICT_LINES[@]}")"
    fi
    printf '%s\n' "$lines"
  fi
  ((unmet)) && return 3
  return 0
}

#######################################
# 항목 하나가 풀렸는가. 안 풀렸으면 기다리는 자리(W)·기록 없는 값(M)·사유를 쌓는다.
# Globals:
#   EXTRA_GATE_DIR (읽음) · REVIEW_VERDICT_REASONS, REVIEW_VERDICT_LINES (씀)
# Arguments:
#   $1 — 판독기 종류(S|D|P|N), $2 — 나머지(값 또는 자리 목록), $3 — 물리 세션 루트
# Returns:
#   0 충족 · 1 미충족
#######################################
review_item_met() {
  local kind="${1:-}" rest="${2:-}" root="${3:-}"
  case "$kind" in
    D)
      dirs_have_fresh_review "$rest" && return 0
      note_waiting_dirs "$rest"
      return 1 ;;
    P)
      note_verdict_reason missing-record
      note_verdict_line "M $rest"
      return 1 ;;
    N)
      if [[ -z "${EXTRA_GATE_DIR:-}" ]]; then
        note_verdict_reason dir-unknown
      elif is_slot_entry "$rest" "$root"; then
        if has_record_separator "$rest"; then
          note_verdict_reason unrecordable
        else
          note_verdict_reason missing-record
        fi
        note_verdict_line "M $rest"
        return 1
      fi ;;
  esac
  dirs_have_fresh_review "$root/_workspace" && return 0
  note_verdict_line "W $root/_workspace"
  return 1
}

#######################################
# 자리 중 한 곳에 플래그보다 새, 비지 않은 일반 파일 *codex*.md 가 있는가.
# 디렉터리·0바이트 파일은 리뷰가 아니다(Stop 3.5 의 기존 판정과 같다).
# Globals:
#   DUALREVIEW_FLAG, REVIEW_RECORD_SEP (읽음)
# Arguments:
#   $1 — US 로 구분한 자리 목록
# Returns:
#   0 있음 · 1 없음
#######################################
dirs_have_fresh_review() {
  local rest="${1:-}" flag="${DUALREVIEW_FLAG:-}" d f
  [[ -n "$rest" && -e "$flag" ]] || return 1
  rest="$rest$REVIEW_RECORD_SEP"
  while [[ -n "$rest" ]]; do
    d="${rest%%"$REVIEW_RECORD_SEP"*}"
    rest="${rest#*"$REVIEW_RECORD_SEP"}"
    [[ -n "$d" ]] || continue
    for f in "$d"/*codex*.md; do
      [[ -f "$f" && -s "$f" && "$f" -nt "$flag" ]] && return 0
    done
  done
  return 1
}

#######################################
# 미충족 항목이 기다리는 자리마다 `W <자리>` 를 쌓는다.
# Globals:
#   REVIEW_RECORD_SEP (읽음) · REVIEW_VERDICT_LINES (씀)
# Arguments:
#   $1 — US 로 구분한 자리 목록
#######################################
note_waiting_dirs() {
  local rest="${1:-}$REVIEW_RECORD_SEP" d
  while [[ -n "$rest" ]]; do
    d="${rest%%"$REVIEW_RECORD_SEP"*}"
    rest="${rest#*"$REVIEW_RECORD_SEP"}"
    [[ -n "$d" ]] && note_verdict_line "W $d"
  done
}

#######################################
# 사유 코드 하나를 중복 없이 쌓는다.
# Globals:
#   REVIEW_VERDICT_REASONS (씀)
# Arguments:
#   $1 — 사유 코드
#######################################
note_verdict_reason() {
  local code="${1:-}" have="$REVIEW_VERDICT_REASONS"
  case " $have " in
    *" $code "*) ;;
    *) REVIEW_VERDICT_REASONS="${have:+$have }$code" ;;
  esac
}

#######################################
# 결과 줄 하나를 쌓는다(중복은 judge_review_rows 가 낼 때 지운다).
# Globals:
#   REVIEW_VERDICT_LINES (씀)
# Arguments:
#   $1 — `W <자리>` 또는 `M <값>`
#######################################
note_verdict_line() {
  REVIEW_VERDICT_LINES+=("${1:-}")
}
