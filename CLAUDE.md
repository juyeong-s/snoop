# Snoop — 프로젝트 컨텍스트

VS Code / Cursor 확장. 함수에 호버하면 AI가 구현 로직을 설명한다.
Open VSX(`wintershin.snoop`)와 VS Code 마켓플레이스에 배포됨.

## 아키텍처

- `executeDefinitionProvider` → `executeDocumentSymbolProvider` 순으로
  언어 서버를 이용해 함수 본문을 추출한다. 이게 핵심 로직.
- BYOK 방식. Gemini/OpenAI/Anthropic/Groq/Ollama 지원.
  키는 `context.secrets`에 저장. 키 접두사로 provider 자동 감지.
- 결과는 소스 해시 기반으로 메모리 캐시.

## 결과 표시 방식

**Comments API 인라인 위젯** (`src/comments.ts`). 함수 아래에 결과를 그린다.

검토하고 버린 방법과 이유:
1. 호버 툴팁 안에서 클릭 → 분석중 → 결과
   → 불가능. Hover API 는 한 번 반환하면 갱신할 수 없다.
2. 호버할 때마다 LLM 호출
   → 토큰을 너무 먹는다. 무료 티어가 5분 만에 소진됨.
3. 사이드 패널(Webview)
   → 동작하지만 시선 이동이 불편해 폐기.
4. `createTextEditorDecorationType`
   → `after.contentText` 는 **첫 줄만** 렌더되고 새 줄을 만들 수 없다.
   가상 요소라 클릭도 안 된다. 짧은 라벨용 API 라 문단에는 안 맞음.
5. `createWebviewTextEditorInset`
   → 이상적이지만 proposed API. 마켓플레이스 배포 불가.

Comments API 는 여러 줄 마크다운, 함수 아래 새 줄, 클릭 가능한 액션,
실시간 갱신이 모두 되고 문서를 수정하지 않는다.
Cursor 에서 렌더되는 것을 스파이크로 확인했다 (2026-08-26).

주의:
- 위젯은 range 의 **끝 줄 아래**에 그려진다. 시그니처 바로 밑에 띄우려면
  전체 범위가 아니라 `selectionRange`(함수명)를 넘겨야 한다.
- 스레드 키는 요청마다 고유해야 한다. 앵커(`uri#줄`)로만 키를 잡으면
  재분석 시 취소가 늦게 전파된 옛 청크가 새 위젯에 섞인다.
- 청크마다 `thread.comments` 를 재할당하면 깜빡인다. 120ms 스로틀.

`src/panel.ts` 는 dead code. 아직 git 에 추가된 적이 없어 삭제하면
복구할 수 없으므로, 새 방식이 충분히 검증된 뒤 지운다.

## 제약

- `engines.vscode`는 `^1.85.0` 유지 (Cursor 호환)
- Cursor에서는 `vscode.lm` API를 쓸 수 없음
- 설명 언어는 `snoop.language` 설정, `auto`면 에디터 언어를 따라감
- 한국어/일본어는 영어보다 토큰을 2~3배 먹으므로 max_tokens 보정 필요
