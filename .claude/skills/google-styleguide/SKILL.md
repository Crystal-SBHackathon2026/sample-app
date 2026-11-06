---
name: google-styleguide
description: 코드·문서를 쓰거나 고치거나 검수할 때 반드시 사용. Google 스타일 가이드(github.com/google/styleguide)를 이 프로젝트의 최우선 스타일 정본으로 적용한다 — Go·Java·TypeScript·JavaScript·Python·Shell·C++ 코드 작성/리뷰, 마크다운 문서·README·설계서·PR 본문 작성, "스타일", "포맷", "네이밍", "컨벤션", "코딩 규칙", "문서 형식" 관련 질문·수정·검수 시 트리거. 다른 스타일 규칙(readable-writing·ecc coding-style·개인 취향)과 충돌하면 이 스킬이 이긴다. 코드나 문서를 한 줄이라도 쓰는 작업이면 예외 없이 먼저 읽어라.
---

# Google 스타일 가이드 (최우선 정본)

> **정본:** https://github.com/google/styleguide (Apache-2.0)
> **원문 사본:** `references/` — 네트워크 없이 읽는다. 갱신은 `scripts/fetch-guides.sh`.
> **확정:** kty, 2026-09-04 — "무조건 이걸로, 우선순위 갖게."

## 왜 이 스킬이 존재하나

스타일 논쟁은 리뷰 시간을 먹고 결론이 안 난다. 취향으로 다투는 대신 **외부의 공개된
정본 하나**를 정해 두면, 리뷰는 "내 취향과 다르다"가 아니라 "정본의 이 줄과 다르다"로
끝난다. 그 정본이 Google 스타일 가이드다.

## 우선순위 (충돌 시 판정 규칙)

아래 순서로 이긴다. 위가 아래를 덮는다.

| 순위 | 무엇 | 근거 |
|------|------|------|
| 1 | **Google 스타일 가이드** (이 스킬 + `references/` 원문) | kty 2026-09-04 확정 |
| 2 | `.claude/harness/principles.md` 제0원칙·변경 규약 | 하네스 제0원칙 |
| 3 | `.claude/harness/project-profile.md` 4절 불변식 | 코드에서 확인된 사실 |
| 4 | `readable-writing` 스킬 (한국어 문장 품질) | Google 이 침묵하는 영역 |
| 5 | ecc `rules/` coding-style·web 규칙, 개인 취향 | 최하위 |

**중요 — 1위와 2위는 대부분 다투지 않는다.** Google 가이드는 *표기·형식·명명*을 정하고,
제0원칙은 *구조·경계·교체 가능성*을 정한다. 층이 다르다. 실제로 부딪히는 좁은
지점(예: 인터페이스를 언제 만드는가)에서만 1위가 이긴다.

**Google 이 침묵하면 아래 순위가 그대로 산다.** 이건 Google 자신의 규칙이다 — Go 가이드
`Local consistency` 절: 가이드가 특정 스타일에 관해 말하지 않으면 작성자가 고르되,
주변 코드가 일관된 입장을 취했으면 그것을 따른다. 그래서 다음은 **폐기되지 않는다**:

*   **§ 기호 금지** → 절 참조는 "3절" (kty 확정, Google 침묵)
*   **범위 표기에 물결표 금지** → "G1–G8" 또는 "G1부터 G8"
    (마크다운 취소선 오작동 실사고, Google 침묵)
*   **한국어 사용자 대면 보고** (프로필 1절, Google 침묵)
*   **전문 용어 첫 등장 자리 괄호 풀이** (readable-writing 2원칙, Google 침묵)

## 언어별 정본 매핑

작업하는 언어의 가이드를 **연다.** 기억으로 쓰지 않는다 — 기억은 낡는다.
이 프로젝트가 어떤 언어를 쓰는지는 `.claude/harness/project-profile.md` 2절이 답한다.

| 언어 | 정본 |
|------|------|
| **Go** | `references/go-guide.md` (핵심) → `go-decisions.md` (구체 판정) → `go-best-practices.md` (패턴) |
| **Shell** | `references/shellguide.md` — 하네스 훅 `.claude/hooks/*.sh` 도 이 대상이다 |
| **Markdown** | `references/docguide-style.md`, `docguide-READMEs.md` |
| **Python** | `references/pyguide.md` |
| Java | https://google.github.io/styleguide/javaguide.html |
| TypeScript | https://google.github.io/styleguide/tsguide.html |
| JavaScript | https://google.github.io/styleguide/jsguide.html |
| C++ | https://google.github.io/styleguide/cppguide.html |

로컬 사본이 없는 언어(HTML 문서라 받지 않은 것들)는 위 URL 을 `WebFetch` 로 읽는다.
읽지 못했으면 **"스타일 정본 미확인"이라고 적고** 추측으로 쓰지 않는다.

## Go — 반드시 지키는 핵심 (원문: `references/go-guide.md`)

가이드가 "core guidelines"로 못 박은 것들이다. 나머지는 `go-decisions.md` 에서
그때그때 확인한다.

1.  **`gofmt` 출력과 100% 일치해야 한다.** Google 은 이것을 presubmit(머지 전 자동
    검사)으로 강제한다. 우리도 같다 — `scripts/check-style.sh` 가 저장소의 모든 Go
    모듈에서 `gofmt -l` 을 돌리고, 출력이 비어야 통과다. 생성 코드도 포맷한다.
2.  **MixedCaps, 언더스코어 금지.** 다른 언어 관례를 깨더라도 그렇다. 상수도 예외가
    없다: 공개면 `MaxLength`(`MAX_LENGTH` 아님), 비공개면 `maxLength`(`max_length`
    아님). 지역 변수는 비공개로 친다.
3.  **줄 길이 제한 없음.** 길다고 느껴지면 자르지 말고 **리팩터링**하라. 이미 최대한
    짧으면 길어도 둔다. 특히 **자르지 말아야 할 곳**: 들여쓰기가 바뀌는 지점
    앞(함수 선언·조건문), 긴 문자열(URL)을 여러 줄로 쪼개는 것.
4.  **이름은 짧게, 문맥을 계산에 넣어서.** 쓰이는 자리에서 반복적으로 느껴지지 않게
    (`user.UserName` 금지), 이미 분명한 개념을 다시 말하지 않게.
5.  **로컬 일관성.** 가이드가 침묵하는 지점은 같은 파일·패키지의 기존 입장을 따른다.
    단 **줄 길이 제한**과 **assertion 기반 테스트 라이브러리**는 로컬 관례로
    정당화할 수 없다고 가이드가 명시한다.

스타일 원칙의 우선순위는 가이드 자신이 정해 뒀다:
**명료성(clarity) > 단순성(simplicity) > 간결성(concision) > 유지보수성 > 일관성.**
다툴 때 위가 이긴다.

## 마크다운 문서 — 반드시 지키는 핵심 (원문: `references/docguide-style.md`)

1.  **한 줄 80자.** 근거는 가이드 원문 그대로 — "우리가 코드에서 하는 방식이기 때문".
    도구(코드 검색 등)가 soft wrap 을 안 하므로 소스 줄이 길면 읽기 나빠진다.
    **예외 4종(80자 넘겨도 됨):** 링크, 표, 제목, 코드 블록. 링크 앞뒤의 *텍스트*는
    여전히 감싼다. YAML frontmatter 도 마크다운 본문이 아니므로 대상이 아니다.
2.  **후행 공백 금지.** 줄바꿈이 꼭 필요하면 후행 백슬래시(`\`)를 아껴 쓰되, 가장
    좋은 것은 빈 줄 두 개(문단 분리)로 해결하는 것이다.
3.  **ATX 제목(`#`)만.** `#` 뒤에 공백 하나, 제목 **앞뒤로 빈 줄**. `##제목` 금지.
4.  **H1 은 문서당 하나** — 문서 제목. 그 아래는 H2 부터.
5.  **제목은 유일하고 완결된 이름으로.** `## Foo` / `### Summary` / `## Bar` /
    `### Summary` 처럼 같은 하위 제목이 반복되면 링크·검색이 망가진다.
    `### Foo summary`, `### Bar summary` 로 쓴다.
6.  **긴 목록은 게으른 번호(lazy numbering)** — `1.` `1.` `1.` 로 쓰고 렌더러가 세게
    둔다. 항목을 끼워 넣을 때 번호를 다시 매기는 diff 노이즈가 사라진다.
7.  **중첩 목록 들여쓰기 4칸.** 번호 목록은 `1.` 뒤 공백 2개, 불릿은 `*` 뒤 공백
    3개 — 어느 쪽이든 텍스트가 4칸에 선다. 감싸인 줄도 4칸(중첩 번호 안이면 8칸).
8.  **문서 배치:** 제목 → 짧은 도입 → `[TOC]`(있으면 도입 **뒤**) → 본문 →
    `## See also`.
9.  **HTML 보다 마크다운을 강하게 선호한다.**
10. **README** 는 `docguide-READMEs.md` 를 따른다 — 무엇인지·왜 쓸모있는지·어떻게
    시작하는지·어디서 더 배우는지.

**"Minimum viable documentation"** — 가이드의 철학 절 제목이다. 짧고 유용한 문서가
길고 완벽한 문서를 이긴다. 안 쓴 문서보다 낫고, 낡은 장문보다 최신 단문이 낫다.

## Shell — `references/shellguide.md`

하네스 훅 `.claude/hooks/*.sh` 는 언제나 이 대상이다. 자주 걸리는 것: 들여쓰기 2칸 · 줄 80자 ·
함수명 `snake_case` · 상수는 `UPPER_SNAKE` 후 `readonly` · `[[ ]]` 선호 · 변수는
항상 인용 · `set -euo pipefail` 계열 에러 처리.

하네스 훅은 macOS bash 3.2 제약(연관배열·`mapfile`·`${var,,}` 금지)을 지고 있다.
이 제약이 Google 규칙과 부딪히면 **제약이 이긴다** — 안 돌아가는 코드는 스타일
문제가 아니라 버그다.

## 작업 절차

**코드를 쓸 때**

1.  언어 정본을 연다(위 매핑 표).
2.  쓴다.
3.  기계 검사를 **직접 돌린다**. 보고만 하고 안 돌리면 안 된다.

    ```bash
    bash .claude/skills/google-styleguide/scripts/check-style.sh
    ```
4.  기계가 못 잡는 축(명명·줄 자르기·주석)은 가이드 조항과 대조한다.

**문서를 쓸 때**

1.  `references/docguide-style.md` 의 위 10개 항목을 적용한다.
2.  그 위에 `readable-writing` 을 얹는다 — Google 은 *형식*을, readable-writing 은
    *한국어 문장 품질*을 정한다. 둘은 겹치지 않는다.
3.  80자 초과 줄을 확인한다. `awk` 의 `length` 는 **바이트**를 세어 한글을 3배로
    계산하므로 쓰지 마라. 문자 수로 세야 한다. 링크·표·제목·코드 블록·frontmatter
    줄은 예외다.

    ```bash
    python3 -c 'import sys
    for i, line in enumerate(open(sys.argv[1]).read().splitlines(), 1):
        if len(line) > 80: print(i, len(line))' <파일>
    ```

**검수할 때**

*   지적에 **정본 근거를 적는다**:
    `[스타일] go-guide.md MixedCaps — 상수 MAX_RETRY → MaxRetry`.
*   근거를 못 대는 스타일 지적은 하지 않는다. 그게 이 정본을 둔 이유다.
*   심각도: 기계 검사 실패(`gofmt -l` 비지 않음)는 **HIGH**. 명명·형식 위반은
    **MEDIUM**. Google 이 "prefer"라고만 한 항목은 **LOW**.

## 하지 말 것

*   **원문을 기억으로 인용하지 마라.** `references/` 를 열어 해당 줄을 확인하고
    인용한다. 이 스킬 본문은 요약이지 정본이 아니다.
*   **요청 범위 밖 파일을 스타일 이유로 고치지 마라.** 변경 규약(`principles.md`)이
    여전히 산다 — 남의 파일 포맷 정리는 리뷰어를 배신하는 diff 다. 발견하면
    지적만 한다. 기존 하네스 문서 다수가 80자를 넘지만, 그것을 일괄 재포맷하는
    것은 이 규칙 위반이다. 손대는 파일에서만 적용한다.
*   **가이드에 없는 규칙을 "Google 스타일"이라고 부르지 마라.** 없으면 없다고 말한다.

## 원문 갱신

```bash
bash .claude/skills/google-styleguide/scripts/fetch-guides.sh
```

가져온 날짜는 `references/FETCHED` 에 적힌다. 원문이 바뀌면 이 SKILL.md 요약도
대조해 고친다.
