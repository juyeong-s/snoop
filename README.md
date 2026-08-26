# Snoop

Hover over unfamiliar code and understand it instantly. AI-powered explanations of what a function actually does — great for legacy code and undocumented libraries.

---

## What it does

Hover over a function name and Snoop finds its implementation, reads it, and tells you what it does. No switching to a chat window, no copy-pasting code.

- **Follows definitions across files** — uses your editor’s language server to jump to where the function is actually defined
- **Language agnostic** — works with TypeScript, Python, Go, Rust and more, as long as the language extension is installed
- **Cached** — hovering the same function again shows the explanation instantly, with no API call
- **Bring your own provider** — uses your own API key; Snoop runs no backend of its own
- **Explains in your language** — follows your editor’s display language by default

---

## Getting started

### 1. Install

Search for `Snoop` in the Cursor or VS Code extensions panel.

If it doesn’t appear in search, download the `.vsix` from the Open VSX page and then:

1. Press `Cmd+Shift+P` (`Ctrl+Shift+P` on Windows/Linux)
2. Choose **Extensions: Install from VSIX…**
3. Select the downloaded file

### 2. Get an API key

Pick one provider. **Gemini and Groq have free tiers** and require no payment details, so either is a good place to start.

| Provider | Where to get a key | Free tier |
| --- | --- | --- |
| Google Gemini | aistudio.google.com/apikey | Yes |
| Groq | console.groq.com/keys | Yes |
| OpenAI | platform.openai.com/api-keys | Paid |
| Anthropic | console.anthropic.com | Paid |
| Ollama (local) | No key needed | Free, runs on your machine |

### 3. Add the key

1. `Cmd+Shift+P` → **Snoop: Set API Key**
2. Paste the key and press Enter

The provider is detected from the key format, so there is nothing else to configure.

Your key is stored in your operating system’s secure storage (Keychain on macOS, Credential Manager on Windows) and never written to a settings file.

### 4. Use it

Open any code file, hover over a function name, and wait a moment for the explanation to appear.

---

## Settings

| Setting | Description | Default |
| --- | --- | --- |
| `snoop.enabled` | Enable or disable hover explanations | `true` |
| `snoop.provider` | AI provider: `gemini`, `openai`, `anthropic`, `groq`, `ollama` | `gemini` |
| `snoop.model` | Model name. Leave empty to use the provider’s default | `""` |
| `snoop.baseUrl` | Override the API base URL. Leave empty for the default | `""` |
| `snoop.language` | Language of explanations. `auto` follows your editor | `auto` |

### Recommended companion setting

```json
// Increases the hover delay so requests don't fire
// as the mouse passes over code.
"editor.hover.delay": 800
```

### Keeping your code local

You can run a model on your own machine with Ollama:

```bash
ollama serve
ollama pull qwen2.5-coder:7b
```

Then set `snoop.provider` to `ollama`. No API key is required and your code never leaves your machine.

---

## Commands

| Command | Description |
| --- | --- |
| **Snoop: Set API Key** | Add or replace your API key |
| **Snoop: Select Language** | Choose the language for explanations |
| **Snoop: Clear Cache** | Discard all stored explanations |

---

## Privacy

Snoop sends **the source of the function you hover over** to the AI provider you configure.

- Snoop runs no server of its own. Your code goes only to the provider you chose
- The author of this extension cannot access your code or your API key
- Your key is stored in your OS secure storage via VS Code’s SecretStorage
- Explanations are kept in memory only and are discarded when the window closes

Provider policies differ from one another. **Some free tiers may use your input to train their models.** Please review your provider’s terms before using this on proprietary code.

If you would rather your code never left your machine, use the `ollama` provider.

---

## Requirements

A language extension for your target language must be installed (for example Python, Go, or rust-analyzer). Snoop relies on its language server to locate function definitions.

---

## Known limitations

- **This is an early preview.** Behaviour may change
- Very long functions are only partially analysed
- Compiled libraries often resolve to type declaration files (`.d.ts`) rather than real implementations
- The language server needs a moment after a file is opened, so the first hover may not work
- The cache is cleared when the window closes
- Providers retire models from time to time. If you see an `HTTP 400` or `404` error, set `snoop.model` to a model that is currently available

---

## Release notes

### 0.1.0

- AI-powered hover explanations
- Support for Gemini, OpenAI, Anthropic, Groq and Ollama
- Provider detected automatically from the API key format
- Session cache to avoid repeated requests
