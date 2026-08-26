import * as vscode from "vscode";

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
  range: vscode.Range;
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
      return "openai/gpt-oss-120b";
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-haiku-4-5-20251001";
    case "groq":
      return "openai/gpt-oss-120b";
    case "ollama":
      return "qwen2.5-coder:7b";
    default:
      return "openai/gpt-oss-120b";
  }
}

function readConfig(): ProviderConfig {
  const cfg = vscode.workspace.getConfiguration("snoop");
  const provider = cfg.get<ProviderId>("provider", "gemini");

  return {
    provider,
    model: cfg.get<string>("model", "") || defaultModel(provider),
    baseUrl: cfg.get<string>("baseUrl", "") || DEFAULT_BASE_URLS[provider],
    language: cfg.get<string>("language", "Korean"),
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

async function callLLM(
  fn: ExtractedFunction,
  apiKey: string,
  token: vscode.CancellationToken,
): Promise<string> {
  const cfg = readConfig();
  const { system, user } = buildPrompt(fn, cfg.language);

  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());

  let url: string;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let body: unknown;

  if (cfg.provider === "gemini") {
    url =
      `${cfg.baseUrl}/models/${cfg.model}:generateContent` +
      `?key=${encodeURIComponent(apiKey)}`;
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.2 },
    };
  } else if (cfg.provider === "anthropic") {
    url = `${cfg.baseUrl}/messages`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: cfg.model,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    };
  } else {
    // OpenAI 호환: openai / groq / ollama
    url = `${cfg.baseUrl}/chat/completions`;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    body = {
      model: cfg.model,
      max_completion_tokens: 2000,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
  }

  log(`요청: ${cfg.provider} / ${cfg.model}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log(`HTTP ${response.status}: ${detail.slice(0, 800)}`);
    
    // 제공자가 보낸 구체적인 메시지를 추출한다.
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

  const data = (await response.json()) as any;

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? // gemini
    data?.content?.[0]?.text ?? // anthropic
    data?.choices?.[0]?.message?.content; // openai 호환

  if (typeof text !== "string" || text.trim() === "") {
    log(`예상치 못한 응답: ${JSON.stringify(data).slice(0, 800)}`);
    throw new Error("빈 응답을 받았습니다. 출력 패널을 확인하세요.");
  }

  return text.trim();
}

/* ================================================================== */
/* 캐시                                                                */
/* ================================================================== */

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
      return new vscode.Hover(md, wordRange);
    }

    // --- 키가 없으면 설정 링크만 ------------------------------------
    const apiKey = await getApiKey(this.context, false);
    if (apiKey === undefined) {
      md.appendMarkdown(`**${fn.name}**\n\n`);
      md.appendMarkdown(`[$(key) Snoop: API 키 설정](command:snoop.setApiKey)`);
      return new vscode.Hover(md, wordRange);
    }

    // --- 폭주 방지 --------------------------------------------------
    if (!allowRequest()) {
      md.appendMarkdown(
        `**${fn.name}**\n\n_요청이 너무 잦습니다. 잠시 후 다시 시도하세요._`,
      );
      return new vscode.Hover(md, wordRange);
    }

    // --- 여기서 await 하면 VS Code 가 로딩 상태를 알아서 그린다 ------
    try {
      const explanation = await callLLM(fn, apiKey, token);
      if (token.isCancellationRequested) {
        return undefined;
      }
      cache.set(key, explanation);
      md.appendMarkdown(`$(sparkle) **${fn.name}**\n\n${explanation}`);
      if (fn.truncated) {
        md.appendMarkdown("\n\n_※ 함수가 길어 앞부분만 분석했습니다._");
      }
      return new vscode.Hover(md, wordRange);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`오류: ${message}`);
      md.appendMarkdown(`**${fn.name}**\n\n$(warning) ${message}`);
      return new vscode.Hover(md, wordRange);
    }
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
  arg?: ExplainArgs,
): Promise<void> {
  let document: vscode.TextDocument | undefined;
  let position: vscode.Position | undefined;

  if (arg?.uri) {
    document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(arg.uri),
    );
    position = new vscode.Position(arg.line, arg.character);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      document = editor.document;
      position = editor.selection.active;
    }
  }

  if (!document || !position) {
    vscode.window.showWarningMessage("Snoop: 대상을 찾지 못했습니다.");
    return;
  }

  const fn = await extractFunctionAt(document, position);
  if (!fn) {
    vscode.window.showWarningMessage(
      "Snoop: 이 위치에서 함수를 찾지 못했습니다.",
    );
    return;
  }

  const key = cacheKey(fn);

  if (cache.has(key)) {
    // await reshowHover(document, position);
    return;
  }

  const apiKey = await getApiKey(context, true);
  if (apiKey === undefined) {
    return;
  }

  inFlight.add(key);
  // 요청 시작 직후 호버를 띄워 "분석 중" 상태를 보여준다.
  //   await reshowHover(document, position);

  try {
    const explanation = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Snoop: ${fn.name}`,
        cancellable: true,
      },
      (_progress, token) => callLLM(fn, apiKey, token),
    );

    cache.set(key, explanation);
    // await reshowHover(document, position);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return; // 사용자가 취소함
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`오류: ${message}`);
    vscode.window.showErrorMessage(`Snoop: ${message}`);
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
    vscode.commands.registerCommand("snoop.clearCache", () => {
      const count = cache.size;
      cache.clear();
      vscode.window.showInformationMessage(
        `Snoop: 캐시 ${count}건을 지웠습니다.`,
      );
    }),
  );

  // 모델이나 언어가 바뀌면 이전 결과가 무의미하므로 캐시를 비운다.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("snoop")) {
        cache.clear();
      }
    }),
  );

  log("Snoop activated.");
}

export function deactivate(): void {
  cache.clear();
}
