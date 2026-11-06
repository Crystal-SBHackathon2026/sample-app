# 구현 근거

2026-11-04에 읽은 Notion 명세 기준. 외부 문서의 완료 표시는 실제 실행 증거와 별개다.

- [데모앱 작업](https://app.notion.com/p/40c8bee9ada4805782c7fac399283377)
- [재사용 명세](https://app.notion.com/p/40c8bee9ada4804ca89fc047cb483b73)
- [앱·DB 계약](https://app.notion.com/p/40d8bee9ada480d0994cc29c606c5afb)
- [DB 이전 설계](https://app.notion.com/p/40c8bee9ada480bea6bedf61f63df80d)

DB DDL: public.migration_demo(request_id uuid PK, run_id text,
phase text, request_no bigint, payload text, created_at timestamptz).
모든 필드는 NOT NULL. bigint는 JSON에서 십진 문자열로 주고받는다.
phase는 요청 생성 시점 값이며 커밋 DB는 응답·ledger에 별도로 기록한다.

이 작업은 앱 API와 HTTP 봇을 구현한다. CDC·OPA·DB 권한 차단과
왕복 이전 오케스트레이터는 팀의 별도 작업이다.
