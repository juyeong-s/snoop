import * as vscode from "vscode";
import { SnoopComments, ThreadTarget } from './comments';

/* ================================================================== */
/* 상수                                                                */
/* ================================================================== */

const FUNCTION_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Variable,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Field,
]);

const MAX_SOURCE_CHARS = 8000;
const SECRET_KEY = "snoop.apiKey";

let output: vscode.OutputChannel;

/** 함수 아래에 결과를 그리는 인라인 위젯 관리자 */
let comments: SnoopComments;

/** 소스 해시 → 설명. 세션 동안만 유지된다. */
const cache = new Map<string, string>();

/** 같은 함수에 대한 중복 요청 방지 */
const inFlight = new Set<string>();

/* ================================================================== */
/* 타입                                                                */
/* ================================================================== */

interface Definition {
  uri: vscode.Uri;
  range: vscode.Range;
}

interface ExtractedFunction {
  name: string;
  kind: vscode.SymbolKind;
  uri: vscode.Uri;
  /** 함수 전체 범위. 본문 추출과 줄 수 계산에 쓴다. */
  range: vscode.Range;
  /** 함수명이 있는 범위. 결과 위젯을 붙이는 앵커. */
  nameRange: vscode.Range;
  source: string;
  truncated: boolean;
  languageId: string;
}

interface ExplainArgs {
  uri: string;
  line: number;
  character: number;
}

type ProviderId = "gemini" | "openai" | "anthropic" | "groq" | "ollama";

/* ================================================================== */
/* 함수 본문 추출 (4단계와 동일)                                        */
/* ================================================================== */

const RATE_LIMIT_PER_MINUTE = 20;
let requestTimestamps: number[] = [];

function allowRequest(): boolean {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 60_000);
  if (requestTimestamps.length >= RATE_LIMIT_PER_MINUTE) {
    return false;
  }
  requestTimestamps.push(now);
  return true;
}

function normalizeDefinitions(raw: unknown): Definition[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const result: Definition[] = [];

  for (const item of raw as Array<vscode.Location | vscode.LocationLink>) {
    if ("targetUri" in item) {
      result.push({
        uri: item.targetUri,
        range: item.targetSelectionRange ?? item.targetRange,
      });
    } else if ("uri" in item) {
      result.push({ uri: item.uri, range: item.range });
    }
  }

  return result;
}

type AnySymbol = vscode.DocumentSymbol | vscode.SymbolInformation;

function symbolRange(symbol: AnySymbol): vscode.Range | undefined {
  if ("range" in symbol && symbol.range) {
    return symbol.range;
  }
  if ("location" in symbol && symbol.location) {
    return symbol.location.range;
  }
  return undefined;
}

/**
 * 심볼 이름만의 범위. DocumentSymbol 은 selectionRange 로 따로 주지만
 * SymbolInformation 은 전체 범위밖에 없어 그대로 돌려준다.
 */
function symbolNameRange(symbol: AnySymbol): vscode.Range | undefined {
  if ("selectionRange" in symbol && symbol.selectionRange) {
    return symbol.selectionRange;
  }
  return symbolRange(symbol);
}

function rangeWeight(range: vscode.Range): number {
  return (
    (range.end.line - range.start.line) * 100_000 +
    (range.end.character - range.start.character)
  );
}

function findEnclosingFunction(
  symbols: AnySymbol[],
  position: vscode.Position,
): AnySymbol | undefined {
  let best: AnySymbol | undefined;
  let bestWeight = Number.POSITIVE_INFINITY;

  const visit = (nodes: AnySymbol[]): void => {
    for (const node of nodes) {
      const range = symbolRange(node);
      if (!range || !range.contains(position)) {
        continue;
      }

      if (FUNCTION_KINDS.has(node.kind)) {
        const weight = rangeWeight(range);
        if (weight < bestWeight) {
          best = node;
          bestWeight = weight;
        }
      }

      const children = (node as vscode.DocumentSymbol).children;
      if (Array.isArray(children) && children.length > 0) {
        visit(children);
      }
    }
  };

  visit(symbols);
  return best;
}

async function extractFunctionAt(
  document: vscode.TextDocument,
  position: vscode.Position,
  token?: vscode.CancellationToken,
): Promise<ExtractedFunction | undefined> {
  const rawDefs = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    document.uri,
    position,
  );

  if (token?.isCancellationRequested) {
    return undefined;
  }

  const defs = normalizeDefinitions(rawDefs);
  if (defs.length === 0) {
    return undefined;
  }

  const def = defs[0];
  const defDocument = await vscode.workspace.openTextDocument(def.uri);

  if (token?.isCancellationRequested) {
    return undefined;
  }

  const rawSymbols = await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    def.uri,
  );

  if (!Array.isArray(rawSymbols) || rawSymbols.length === 0) {
    return undefined;
  }

  const symbol = findEnclosingFunction(
    rawSymbols as AnySymbol[],
    def.range.start,
  );
  if (!symbol) {
    return undefined;
  }

  const fullRange = symbolRange(symbol);
  if (!fullRange) {
    return undefined;
  }

  const nameRange = symbolNameRange(symbol) ?? fullRange;

  let source = defDocument.getText(fullRange);
  let truncated = false;

  if (source.length > MAX_SOURCE_CHARS) {
    source = source.slice(0, MAX_SOURCE_CHARS);
    truncated = true;
  }

  return {
    name: symbol.name,
    kind: symbol.kind,
    uri: def.uri,
    range: fullRange,
    nameRange,
    source,
    truncated,
    languageId: defDocument.languageId,
  };
}

/* ================================================================== */
/* 설정                                                                */
/* ================================================================== */

interface ProviderConfig {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  language: string;
}

const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
};

function defaultModel(provider: ProviderId): string {
  switch (provider) {
    case "gemini":
      return "gemini-3-flash-preview";
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-haiku-4-5-20251001";
    case "groq":
      return "openai/gpt-oss-120b";
    case "ollama":
      return "qwen2.5-coder:7b";
    default:
      return "gemini-3-flash-preview";
  }
}

function maxTokensFor(language: string): number {
  const heavy = [
    'Korean', 'Japanese', 'Simplified Chinese',
    'Traditional Chinese', 'Thai', 'Hindi',
  ];
  return heavy.includes(language) ? 2000 : 1000;
}

/** 설정값 → 프롬프트에 넣을 언어 이름. LLM은 영어 명칭을 가장 잘 인식한다. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ko: 'Korean',
  ja: 'Japanese',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  'pt-BR': 'Brazilian Portuguese',
  ru: 'Russian',
  it: 'Italian',
  vi: 'Vietnamese',
  id: 'Indonesian',
  hi: 'Hindi',
  th: 'Thai',
  tr: 'Turkish',
  pl: 'Polish',
};

/** 설정 UI에 보여줄 이름 */
const LANGUAGE_LABELS: Record<string, string> = {
  auto: 'Auto (editor language)',
  en: 'English',
  ko: '한국어',
  ja: '日本語',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  'pt-BR': 'Português do Brasil',
  ru: 'Русский',
  it: 'Italiano',
  vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia',
  hi: 'हिन्दी',
  th: 'ไทย',
  tr: 'Türkçe',
  pl: 'Polski',
};

/**
 * 'auto' 이면 에디터 표시 언어를 따라간다.
 * vscode.env.language 는 'ko', 'zh-cn' 처럼 소문자로 온다.
 */
function resolveLanguage(setting: string): string {
  if (setting !== 'auto') {
    return LANGUAGE_NAMES[setting] ?? 'English';
  }

  const raw = vscode.env.language.toLowerCase();
  const exact = Object.keys(LANGUAGE_NAMES).find(
    (code) => code.toLowerCase() === raw
  );
  if (exact) {
    return LANGUAGE_NAMES[exact];
  }

  // 'pt-pt' → 'pt' 처럼 지역 코드를 떼고 다시 찾는다.
  const base = raw.split('-')[0];
  const partial = Object.keys(LANGUAGE_NAMES).find(
    (code) => code.toLowerCase().split('-')[0] === base
  );
  return partial ? LANGUAGE_NAMES[partial] : 'English';
}

function readConfig(): ProviderConfig {
  const cfg = vscode.workspace.getConfiguration("snoop");
  const provider = cfg.get<ProviderId>("provider", "gemini");

  return {
    provider,
    model: cfg.get<string>("model", "") || defaultModel(provider),
    baseUrl: cfg.get<string>("baseUrl", "") || DEFAULT_BASE_URLS[provider],
    language: resolveLanguage(cfg.get<string>('language', 'auto')),
  };
}

/* ================================================================== */
/* LLM 호출                                                            */
/* ================================================================== */

function buildPrompt(fn: ExtractedFunction, language: string) {
  const system =
    `You explain code to developers reading an unfamiliar codebase. ` +
    `Respond in ${language}.\n\n` +
    `Hard constraints:\n` +
    `- The whole answer must fit in a small hover tooltip.\n` +
    `- Start with 1-2 sentences on what this does and why it exists.\n` +
    `- Then at most 3 bullets, one line each, for non-obvious details ` +
    `(side effects, error handling, edge cases, performance traps). ` +
    `Omit the bullets entirely if the function is trivial.\n` +
    `- Never restate the signature or repeat the code.\n` +
    `- No headings, no preamble, no closing summary.\n` +
    `- Finish your last sentence. Never trail off.`;

  const user =
    `Language: ${fn.languageId}\n` +
    `Symbol: ${fn.name}\n` +
    (fn.truncated ? "Note: source was truncated.\n" : "") +
    `\n\`\`\`${fn.languageId}\n${fn.source}\n\`\`\``;

  return { system, user };
}

function describeHttpError(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'API 키가 올바르지 않습니다. "Snoop: Set API Key"로 다시 설정하세요.';
    case 404:
      return "모델 이름이 잘못되었습니다. snoop.model 설정을 확인하세요.";
    case 429:
      return "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.";
    default:
      return status >= 500
        ? "제공자 서버 오류입니다. 잠시 후 다시 시도하세요."
        : `요청 실패 (HTTP ${status}). 출력 패널을 확인하세요.`;
  }
}

/**
 * LLM 을 스트리밍으로 호출한다. 조각이 도착할 때마다 onChunk 가 불린다.
 * 반환값은 전체 텍스트(캐시 저장용).
 */
async function callLLMStream(
  fn: ExtractedFunction,
  apiKey: string,
  token: vscode.CancellationToken,
  onChunk: (text: string) => void
): Promise<string> {
  const cfg = readConfig();
  const { system, user } = buildPrompt(fn, cfg.language);
  const maxTokens = maxTokensFor(cfg.language);

  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());

  let url: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: unknown;

  if (cfg.provider === 'gemini') {
    url =
      `${cfg.baseUrl}/models/${cfg.model}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(apiKey)}`;
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
    };
  } else if (cfg.provider === 'anthropic') {
    url = `${cfg.baseUrl}/messages`;
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: cfg.model,
      max_tokens: maxTokens,
      system,
      stream: true,
      messages: [{ role: 'user', content: user }],
    };
  } else {
    url = `${cfg.baseUrl}/chat/completions`;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    body = {
      model: cfg.model,
      max_completion_tokens: maxTokens,
      temperature: 0.2,
      stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
  }

  log(`스트리밍 요청: ${cfg.provider} / ${cfg.model}`);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log(`HTTP ${response.status}: ${detail.slice(0, 800)}`);

    let providerMessage = '';
    try {
      const parsed = JSON.parse(detail);
      providerMessage = parsed?.error?.message ?? parsed?.message ?? '';
    } catch {
      // 무시
    }

    const base = describeHttpError(response.status);
    throw new Error(providerMessage ? `${base}\n\n${providerMessage}` : base);
  }

  if (!response.body) {
    throw new Error('스트리밍 응답을 받지 못했습니다.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE 는 빈 줄로 이벤트를 구분한다.
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }

          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') {
            continue;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          const piece =
            parsed?.candidates?.[0]?.content?.parts?.[0]?.text ??  // gemini
            parsed?.delta?.text ??                                 // anthropic
            parsed?.choices?.[0]?.delta?.content;                  // openai 호환

          if (typeof piece === 'string' && piece !== '') {
            full += piece;
            onChunk(piece);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (full.trim() === '') {
    throw new Error('빈 응답을 받았습니다. 출력 패널을 확인하세요.');
  }

  return full.trim();
}

/**
 * 캐시 키 생성용 해시 (FNV 계열 변형).
 * 암호학적 용도가 아니라 Node 의 crypto 모듈에 의존하지 않는다.
 */
function hash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

function cacheKey(fn: ExtractedFunction): string {
  const cfg = readConfig();
  return hash(`${cfg.provider}|${cfg.model}|${cfg.language}|${fn.source}`);
}

function detectProvider(key: string): ProviderId | undefined {
  if (key.startsWith('AIza')) { return 'gemini'; }
  if (key.startsWith('sk-ant-')) { return 'anthropic'; }
  if (key.startsWith('gsk_')) { return 'groq'; }
  if (key.startsWith('sk-')) { return 'openai'; }   // sk-ant- 뒤에 와야 함
  return undefined;
}

/* ================================================================== */
/* 호버 프로바이더                                                      */
/* ================================================================== */

class SnoopHoverProvider implements vscode.HoverProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const cfg = vscode.workspace.getConfiguration("snoop");
    if (!cfg.get<boolean>("enabled", true)) {
      return undefined;
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return undefined;
    }

    const fn = await extractFunctionAt(document, position, token);
    if (!fn || token.isCancellationRequested) {
      return undefined;
    }

    const key = cacheKey(fn);
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    // --- 캐시 히트 -------------------------------------------------
    const cached = cache.get(key);
    if (cached) {
      md.appendMarkdown(`$(sparkle) **${fn.name}**\n\n${cached}`);
      if (fn.truncated) {
        md.appendMarkdown("\n\n_※ 함수가 길어 앞부분만 분석했습니다._");
      }

      // 툴팁은 마우스를 떼면 사라지므로, 아래에 고정할 수단을 남긴다.
      const pinArgs = encodeURIComponent(
        JSON.stringify({
          uri: document.uri.toString(),
          line: position.line,
          character: position.character,
        } satisfies ExplainArgs)
      );
      md.appendMarkdown(
        `\n\n[$(pin) 함수 아래에 고정](command:snoop.explain?${pinArgs})`
      );

      return new vscode.Hover(md, wordRange);
    }

    // --- 키가 없으면 설정 링크만 ------------------------------------
    const apiKey = await getApiKey(this.context, false);
    if (apiKey === undefined) {
      md.appendMarkdown(`**${fn.name}**\n\n`);
      md.appendMarkdown(`[$(key) Snoop: API 키 설정](command:snoop.setApiKey)`);
      return new vscode.Hover(md, wordRange);
    }

    const args: ExplainArgs = {
      uri: document.uri.toString(),
      line: position.line,
      character: position.character,
    };
    const encoded = encodeURIComponent(JSON.stringify(args));
    const lines = fn.range.end.line - fn.range.start.line + 1;

    md.appendMarkdown(`**${fn.name}**  \n`);
    md.appendMarkdown(`_${lines} lines · ${fn.languageId}_\n\n`);
    md.appendMarkdown(
      `[$(search) Explain with Snoop](command:snoop.explain?${encoded})`
    );

    return new vscode.Hover(md, wordRange);
  }
}

/* ================================================================== */
/* 커맨드                                                              */
/* ================================================================== */

async function getApiKey(
  context: vscode.ExtensionContext,
  promptIfMissing: boolean,
): Promise<string | undefined> {
  const provider = readConfig().provider;

  // Ollama 는 로컬이라 키가 필요 없다.
  if (provider === "ollama") {
    return "";
  }

  const existing = await context.secrets.get(SECRET_KEY);
  if (existing) {
    return existing;
  }

  if (!promptIfMissing) {
    return undefined;
  }

  const entered = await vscode.window.showInputBox({
    title: `Snoop: ${provider} API key`,
    prompt: "키는 OS 보안 저장소에 저장되며 설정 파일에는 남지 않습니다.",
    password: true,
    ignoreFocusOut: true,
  });

  if (entered && entered.trim()) {
    await context.secrets.store(SECRET_KEY, entered.trim());
    return entered.trim();
  }

  return undefined;
}

/**
 * 호버는 한 번 반환하면 갱신할 수 없다.
 * 그래서 커서를 해당 위치로 옮기고 호버를 강제로 다시 띄운다.
 * 이 시점에는 캐시가 채워져 있으므로 설명이 즉시 표시된다.
 */
// async function reshowHover(
// 	document: vscode.TextDocument,
// 	position: vscode.Position
//   ): Promise<void> {
// 	const editor = await vscode.window.showTextDocument(document, {
// 	  preserveFocus: false,
// 	  preview: false,
// 	  viewColumn: vscode.ViewColumn.Active,
// 	});

// 	editor.selection = new vscode.Selection(position, position);
// 	editor.revealRange(new vscode.Range(position, position));

// 	// 선택 변경이 반영될 시간을 준다. 이게 없으면 호버가 안 뜨거나
// 	// 이전 위치 기준으로 뜬다.
// 	await new Promise((resolve) => setTimeout(resolve, 60));

// 	// 이미 열려 있는 호버를 닫아야 새 내용으로 다시 그려진다.
// 	await vscode.commands.executeCommand('closeMarkersNavigation');
// 	await vscode.commands.executeCommand('editor.action.showHover');
// }

async function explainCommand(
  context: vscode.ExtensionContext,
  arg?: ExplainArgs
): Promise<void> {
  let document: vscode.TextDocument | undefined;
  let position: vscode.Position | undefined;

  if (arg?.uri) {
    document = await vscode.workspace.openTextDocument(vscode.Uri.parse(arg.uri));
    position = new vscode.Position(arg.line, arg.character);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      document = editor.document;
      position = editor.selection.active;
    }
  }

  if (!document || !position) {
    vscode.window.showWarningMessage('Snoop: 대상을 찾지 못했습니다.');
    return;
  }

  const fn = await extractFunctionAt(document, position);
  if (!fn) {
    vscode.window.showWarningMessage('Snoop: 이 위치에서 함수를 찾지 못했습니다.');
    return;
  }

  const lines = fn.range.end.line - fn.range.start.line + 1;

  // 위젯은 정의부가 있는 파일에 붙는다. 호출한 쪽이 아니라 fn.uri 기준이다.
  // range 의 끝 줄 아래에 그려지므로, 함수명 범위를 넘겨야 시그니처
  // 바로 밑에 나온다. 전체 범위를 넘기면 닫는 중괄호 아래로 밀린다.
  const target: ThreadTarget = {
    uri: fn.uri,
    range: fn.nameRange,
    title: fn.name,
    subtitle: `${lines} lines · ${fn.languageId}`,
    truncated: fn.truncated,
    explainArgs: {
      uri: fn.uri.toString(),
      line: fn.range.start.line,
      character: fn.range.start.character,
    } satisfies ExplainArgs,
  };

  const key = cacheKey(fn);

  // 캐시가 있으면 요청 없이 바로 채운다.
  const cached = cache.get(key);
  if (cached) {
    comments.setContent(target, cached);
    return;
  }

  const apiKey = await getApiKey(context, true);
  if (apiKey === undefined) {
    return;
  }

  const { key: threadKey, token } = comments.begin(target);

  if (!allowRequest()) {
    comments.showError(threadKey, '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.');
    return;
  }

  inFlight.add(key);

  try {
    const full = await callLLMStream(fn, apiKey, token, (piece) => {
      comments.append(threadKey, piece);
    });

    cache.set(key, full);
    comments.finish(threadKey, full);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return; // 사용자가 취소했거나 같은 함수에 새 요청이 시작됨
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`오류: ${message}`);
    comments.showError(threadKey, message);
  } finally {
    inFlight.delete(key);
  }
}

/* ================================================================== */
/* 활성화                                                              */
/* ================================================================== */

function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Snoop");
  context.subscriptions.push(output);

  comments = new SnoopComments();
  context.subscriptions.push(comments);

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      new SnoopHoverProvider(context),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("snoop.explain", (arg?: ExplainArgs) =>
      explainCommand(context, arg),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snoop.setApiKey', async () => {
      const entered = await vscode.window.showInputBox({
        title: 'Snoop: API key',
        prompt: 'Gemini(AIza…), OpenAI(sk-…), Anthropic(sk-ant-…), Groq(gsk_…)',
        password: true,
        ignoreFocusOut: true,
      });

      if (!entered || !entered.trim()) {
        return;
      }

      const key = entered.trim();
      const cfg = vscode.workspace.getConfiguration('snoop');
      const detected = detectProvider(key);

      if (detected) {
        await cfg.update('provider', detected, vscode.ConfigurationTarget.Global);
        // 이전 제공자의 모델명이 남아 있으면 404 가 나므로 비운다.
        await cfg.update('model', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `Snoop: ${detected} 키로 설정했습니다.`
        );
      } else {
        vscode.window.showWarningMessage(
          'Snoop: 제공자를 자동 인식하지 못했습니다. 설정에서 snoop.provider를 직접 선택하세요.'
        );
      }

      await context.secrets.store(SECRET_KEY, key);
      cache.clear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('snoop.selectLanguage', async () => {
      const cfg = vscode.workspace.getConfiguration('snoop');
      const current = cfg.get<string>('language', 'auto');

      const items = Object.entries(LANGUAGE_LABELS).map(([code, label]) => ({
        label,
        description: code === current ? '$(check) current' : undefined,
        code,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Snoop: 설명 언어 선택',
        matchOnDescription: true,
      });

      if (!picked) {
        return;
      }

      await cfg.update(
        'language',
        picked.code,
        vscode.ConfigurationTarget.Global
      );
      cache.clear();
      vscode.window.showInformationMessage(
        `Snoop: ${picked.label} (으)로 설정했습니다.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("snoop.clearCache", () => {
      const count = cache.size;
      cache.clear();
      vscode.window.showInformationMessage(
        `Snoop: 캐시 ${count}건을 지웠습니다.`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("snoop.dismissComment", (key?: string) => {
      if (typeof key === "string") {
        comments.dismiss(key);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("snoop.clearComments", () => {
      const count = comments.clearAll();
      vscode.window.showInformationMessage(
        `Snoop: 위젯 개를 닫았습니다.`,
      );
    }),
  );

  // 모델이나 언어가 바뀌면 이전 결과가 무의미하므로 캐시와 위젯을 비운다.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("snoop")) {
        cache.clear();
        comments.clearAll();
      }
    }),
  );

  log("Snoop activated.");
}

export function deactivate(): void {
  cache.clear();
}
