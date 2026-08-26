# Snoop

Hover over unfamiliar code and understand it instantly. AI-powered explanations of what a function actually does — great for legacy code and undocumented libraries.

## Features

Hover over any function and Snoop shows you what its implementation actually does — no context switching, no copy-pasting into a chat window.

- Works across languages via your existing language server
- Explanations generated on demand, not on every hover
- Results are cached, so revisiting a function costs nothing

## Requirements

A language extension for your target language must be installed (e.g. Python, Go, rust-analyzer). Snoop relies on it to locate function definitions.

## Extension Settings

| Setting | Description | Default |
| --- | --- | --- |
| `Snoop.enabled` | Enable or disable hover explanations | `true` |

## Known Issues

Early preview. Explanations for very large functions may be truncated.

## Privacy

Snoop sends the source of the function you hover over to the LLM provider
you configure. Nothing is sent anywhere else, and Snoop has no backend.
Your API key is stored in your OS keychain via VS Code's SecretStorage.

To keep code entirely local, set `snoop.provider` to `ollama`.

## Release Notes

### 0.0.1

Initial preview release.

---

## 한국어

낯선 코드에 마우스를 올리면 그 함수가 실제로 어떤 로직으로 동작하는지 AI가 설명해줍니다. 문서화되지 않은 라이브러리나 레거시 코드를 파악할 때 유용합니다.