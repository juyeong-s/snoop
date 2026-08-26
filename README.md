# Snoop

낯선 코드에 마우스를 올리면 그 함수가 실제로 어떤 로직으로 동작하는지 AI가 설명해줍니다. 문서화되지 않은 라이브러리나 레거시 코드를 파악할 때 유용합니다.

> Hover over unfamiliar code and understand it instantly. AI-powered explanations of what a function actually does — great for legacy code and undocumented libraries. *(English section below)*
> 

---

## 무엇을 하나요

함수 이름에 마우스를 올리면 Snoop이 그 함수의 **구현부를 찾아내 읽고**, 무슨 일을 하는지 설명합니다. 채팅창으로 자리를 옮기거나 코드를 복사해 붙여넣을 필요가 없습니다.

- **다른 파일의 함수도 추적합니다** — 에디터의 언어 서버를 이용해 정의 위치까지 따라갑니다
- **언어를 가리지 않습니다** — 해당 언어 확장만 설치되어 있으면 TypeScript, Python, Go, Rust 등에서 동작합니다
- **한 번 본 함수는 캐시됩니다** — 같은 함수에 다시 호버하면 API 호출 없이 즉시 표시됩니다
- **원하는 AI 제공자를 고를 수 있습니다** — 본인 API 키를 사용하며, Snoop은 별도 서버를 두지 않습니다

---

## 시작하기

### 1. 설치

Cursor 또는 VS Code 확장 검색에서 `Snoop`을 찾아 설치합니다.

검색되지 않는 경우 Open VSX 페이지에서 `.vsix` 파일을 내려받은 뒤:

1. `Cmd+Shift+P` (Windows/Linux는 `Ctrl+Shift+P`)
2. **Extensions: Install from VSIX…** 선택
3. 내려받은 파일 지정

### 2. API 키 발급

원하는 제공자 하나를 고르세요.

| 제공자 | 키 발급처 | 무료 사용 |
| --- | --- | --- |
| Google Gemini | aistudio.google.com/apikey | 가능 |
| Groq | console.groq.com/keys | 가능 |
| OpenAI | platform.openai.com/api-keys | 유료 |
| Anthropic | console.anthropic.com | 유료 |
| Ollama (로컬) | 키 불필요 | 무료 (직접 실행) |

### 3. 키 등록

1. `Cmd+Shift+P` → **Snoop: Set API Key**
2. 발급받은 키를 붙여넣고 Enter

키의 형태를 보고 제공자가 자동으로 설정됩니다. 별도로 설정을 만질 필요가 없습니다.

키는 OS 보안 저장소(macOS 키체인, Windows 자격 증명 관리자 등)에 저장되며 설정 파일에는 남지 않습니다.

### 4. 사용

아무 코드 파일을 열고 함수 이름에 마우스를 올린 뒤 잠시 기다리면 설명이 나타납니다.

---

## 설정

| 설정 | 설명 | 기본값 |
| --- | --- | --- |
| `snoop.enabled` | 호버 설명 사용 여부 | `true` |
| `snoop.provider` | AI 제공자 (`gemini`, `openai`, `anthropic`, `groq`, `ollama`) | `gemini` |
| `snoop.model` | 사용할 모델 이름. 비워두면 제공자별 기본값 사용 | `""` |
| `snoop.baseUrl` | API 주소 직접 지정. 비워두면 기본 주소 사용 | `""` |
| `snoop.language` | 설명 언어 (`Korean`, `English`, `Japanese` 등) | `Korean` |

### 함께 권하는 설정

```json
// 마우스가 스쳐 지나갈 때 불필요한 요청이 발생하지 않도록
// 호버 대기 시간을 늘리는 것을 권합니다.
"editor.hover.delay": 800
```

### 코드를 외부로 보내고 싶지 않다면

Ollama를 설치해 로컬 모델을 사용할 수 있습니다.

```bash
ollama pull qwen2.5-coder:7b
```

그리고 설정에서 `snoop.provider`를 `ollama`로 변경하세요. API 키가 필요 없고, 코드가 기기 밖으로 나가지 않습니다.

---

## 명령어

| 명령어 | 설명 |
| --- | --- |
| **Snoop: Set API Key** | API 키를 등록하거나 교체합니다 |
| **Snoop: Clear Cache** | 저장된 설명을 모두 지웁니다 |

---

## 개인정보 처리

Snoop은 **마우스를 올린 함수의 소스 코드**를 사용자가 설정한 AI 제공자에게 전송합니다.

- Snoop은 자체 서버를 운영하지 않습니다. 코드는 사용자가 지정한 제공자에게만 전달됩니다
- 개발자(확장 제작자)는 사용자의 코드나 API 키에 접근할 수 없습니다
- API 키는 VS Code의 SecretStorage를 통해 OS 보안 저장소에 저장됩니다
- 설명 결과는 메모리에만 저장되며 창을 닫으면 사라집니다

각 제공자의 데이터 취급 방침은 서로 다릅니다. **특히 일부 무료 요금제는 입력 데이터를 모델 학습에 사용할 수 있습니다.** 업무용 코드에 사용하기 전에 해당 제공자의 정책을 확인하시기 바랍니다.

코드가 외부로 나가는 것을 원하지 않으면 `ollama` 설정을 사용하세요.

---

## 필요 사항

대상 언어의 확장이 설치되어 있어야 합니다 (예: Python, Go, rust-analyzer). Snoop은 해당 언어 서버를 이용해 함수의 정의 위치를 찾습니다.

---

## 알려진 제한 사항

- **초기 미리보기 버전입니다.** 동작이 변경될 수 있습니다
- 매우 긴 함수는 앞부분만 분석될 수 있습니다
- 컴파일된 라이브러리는 타입 선언 파일(`.d.ts`)로 연결되어 실제 구현을 볼 수 없는 경우가 있습니다
- 파일을 연 직후에는 언어 서버가 준비되지 않아 잠시 동작하지 않을 수 있습니다
- 캐시는 창을 닫으면 초기화됩니다

---

## 릴리즈 노트

### 0.1.0

- AI 기반 호버 설명 기능 추가
- Gemini, OpenAI, Anthropic, Groq, Ollama 지원
- API 키 형태를 통한 제공자 자동 인식
- 세션 캐시로 중복 요청 방지

# Snoop *(English)*

Hover over unfamiliar code and understand it instantly. AI-powered explanations of what a function actually does — great for legacy code and undocumented libraries.

## What it does

Hover over a function name and Snoop locates its implementation, reads it, and explains what it does — no context switching, no copy-pasting into a chat window.

- **Follows definitions across files** using your editor’s language server
- **Language agnostic** — works with TypeScript, Python, Go, Rust and more, as long as the language extension is installed
- **Cached** — hovering the same function again costs nothing
- **Bring your own provider** — uses your own API key; Snoop has no backend

## Setup

1. Install the extension, or grab the `.vsix` from Open VSX and use **Extensions: Install from VSIX…**
2. Get an API key. **Gemini and Groq have free tiers** and need no payment details.
3. `Cmd+Shift+P` → **Snoop: Set API Key** and paste it. The provider is detected from the key format.
4. Hover over any function and wait a moment.

| Provider | Get a key | Free tier |
| --- | --- | --- |
| Google Gemini | aistudio.google.com/apikey | Yes |
| Groq | console.groq.com/keys | Yes |
| OpenAI | platform.openai.com/api-keys | No |
| Anthropic | console.anthropic.com | No |
| Ollama (local) | Not required | Free, runs locally |

## Settings

| Setting | Description | Default |
| --- | --- | --- |
| `snoop.enabled` | Enable or disable hover explanations | `true` |
| `snoop.provider` | `gemini`, `openai`, `anthropic`, `groq`, `ollama` | `gemini` |
| `snoop.model` | Model name. Empty uses the provider default | `""` |
| `snoop.baseUrl` | Override the API base URL | `""` |
| `snoop.language` | Language of explanations | `Korean` |

Setting `"editor.hover.delay": 800` is recommended to avoid requests firing as the mouse passes over code.

## Privacy

Snoop sends the source of the function you hover over to the LLM provider you configure. Snoop has no backend of its own, and the author cannot access your code or your key. Your API key is stored in your OS keychain via VS Code’s SecretStorage, and explanations are kept in memory only.

Provider policies differ, and **some free tiers may use your input to train models.** Check your provider’s terms before using this on proprietary code. To keep everything local, set `snoop.provider` to `ollama`.

## Requirements

A language extension for your target language must be installed (e.g. Python, Go, rust-analyzer). Snoop relies on it to locate function definitions.

## Known issues

Early preview. Very long functions are truncated. Compiled libraries may resolve to type declarations rather than real implementations. The language server needs a moment after opening a file. Cache resets when the window closes.
