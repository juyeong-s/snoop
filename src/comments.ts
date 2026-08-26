import * as vscode from 'vscode';

/* ================================================================== */
/* 인라인 결과 위젯 (Comments API)                                      */
/* ================================================================== */

/**
 * 설명 결과를 함수 바로 아래에 인라인 위젯으로 보여준다.
 *
 * Webview 패널과 달리 시선이 코드를 벗어나지 않고, 데코레이션과 달리
 * 여러 줄 마크다운을 그릴 수 있다. 문서를 수정하지 않으므로 파일이
 * dirty 상태가 되거나 undo 스택에 쌓이지 않는다.
 *
 * 위젯은 range 의 "끝 줄 아래"에 그려지므로 함수 전체 범위를 넘겨야
 * 닫는 중괄호 밑에 붙는다.
 */

/** 스트리밍 조각을 모아서 흘려보내는 간격. 매 조각마다 갱신하면 깜빡인다. */
const FLUSH_INTERVAL_MS = 120;

export interface ThreadTarget {
  uri: vscode.Uri;
  /** 위젯을 붙일 앵커. 위젯은 이 범위의 끝 줄 "아래"에 그려진다. */
  range: vscode.Range;
  title: string;
  subtitle: string;
  truncated: boolean;
  /** "다시 분석" 링크가 snoop.explain 에 넘길 인자 */
  explainArgs: unknown;
}

interface Entry {
  /** 요청마다 새로 발급되는 고유 키 */
  key: string;
  /** 함수 위치. 같은 앵커의 이전 요청을 찾아 교체하는 데 쓴다. */
  anchor: string;
  thread: vscode.CommentThread;
  cancel: vscode.CancellationTokenSource;
  target: ThreadTarget;
  /** 지금까지 도착한 전체 텍스트 */
  text: string;
  /** 아직 화면에 반영되지 않은 조각이 있는지 */
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type State = 'loading' | 'streaming' | 'done' | 'error';

export class SnoopComments {
  private readonly controller: vscode.CommentController;
  private readonly entries = new Map<string, Entry>();
  /** 앵커 → 현재 살아 있는 entry 키 */
  private readonly anchors = new Map<string, string>();
  private seq = 0;

  constructor() {
    this.controller = vscode.comments.createCommentController(
      'snoop',
      'Snoop',
    );
  }

  /* ---------------------------------------------------------------- */
  /* 키                                                                */
  /* ---------------------------------------------------------------- */

  /** 함수 위치. 같은 함수를 다시 분석하면 위젯을 쌓지 않고 갈아끼운다. */
  private static anchorOf(target: ThreadTarget): string {
    return `${target.uri.toString()}#${target.range.start.line}`;
  }

  /* ---------------------------------------------------------------- */
  /* 상태 갱신                                                         */
  /* ---------------------------------------------------------------- */

  /** 새 분석을 시작한다. 같은 함수의 이전 요청이 있으면 취소한다. */
  public begin(target: ThreadTarget): { key: string; token: vscode.CancellationToken } {
    const anchor = SnoopComments.anchorOf(target);

    // 같은 함수의 이전 요청을 먼저 정리한다. 키가 서로 다르므로 취소가
    // 늦게 전파돼도 옛 청크가 새 위젯에 섞이지 않는다.
    const previous = this.anchors.get(anchor);
    if (previous !== undefined) {
      this.dismiss(previous);
    }

    const key = `${anchor}@${this.seq++}`;

    const thread = this.controller.createCommentThread(
      target.uri,
      target.range,
      [],
    );
    thread.canReply = false;
    thread.label = `${target.title} · ${target.subtitle}`;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

    const entry: Entry = {
      key,
      anchor,
      thread,
      cancel: new vscode.CancellationTokenSource(),
      target,
      text: '',
      dirty: false,
      timer: undefined,
    };

    this.entries.set(key, entry);
    this.anchors.set(anchor, key);
    this.paint(entry, 'loading');

    return { key, token: entry.cancel.token };
  }

  /** 스트리밍 조각을 덧붙인다. 실제 렌더는 FLUSH_INTERVAL_MS 마다 한 번. */
  public append(key: string, piece: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }

    entry.text += piece;
    entry.dirty = true;

    if (entry.timer !== undefined) {
      return;
    }

    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entry.dirty) {
        entry.dirty = false;
        this.paint(entry, 'streaming');
      }
    }, FLUSH_INTERVAL_MS);
  }

  /** 캐시 히트처럼 요청 없이 결과 전체를 한 번에 보여준다. */
  public setContent(target: ThreadTarget, text: string): void {
    const { key } = this.begin(target);
    this.finish(key, text);
  }

  public finish(key: string, text?: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }

    this.stopTimer(entry);
    if (text !== undefined) {
      entry.text = text;
    }
    this.paint(entry, 'done');
  }

  public showError(key: string, message: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }

    this.stopTimer(entry);
    entry.text = message;
    this.paint(entry, 'error');
  }

  /* ---------------------------------------------------------------- */
  /* 정리                                                              */
  /* ---------------------------------------------------------------- */

  public dismiss(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }

    this.stopTimer(entry);
    entry.cancel.cancel();
    entry.cancel.dispose();
    entry.thread.dispose();
    this.entries.delete(key);

    // 이미 다른 요청이 앵커를 차지했다면 건드리지 않는다.
    if (this.anchors.get(entry.anchor) === key) {
      this.anchors.delete(entry.anchor);
    }
  }

  /** 열려 있는 위젯 전부 닫는다. 닫은 개수를 반환한다. */
  public clearAll(): number {
    const count = this.entries.size;
    for (const key of [...this.entries.keys()]) {
      this.dismiss(key);
    }
    return count;
  }

  public dispose(): void {
    this.clearAll();
    this.controller.dispose();
  }

  private stopTimer(entry: Entry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.dirty = false;
  }

  /* ---------------------------------------------------------------- */
  /* 렌더링                                                            */
  /* ---------------------------------------------------------------- */

  private paint(entry: Entry, state: State): void {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;          // 커맨드 링크를 쓰려면 필요하다
    md.supportThemeIcons = true;

    if (state === 'loading') {
      md.appendMarkdown('$(sync~spin) 분석 중…');
    } else if (state === 'error') {
      md.appendMarkdown(`$(error) ${entry.text}\n\n`);
      md.appendMarkdown(this.footer(entry, false));
    } else {
      // 스트리밍 중에는 끝에 커서를 붙여 아직 오는 중임을 알린다.
      md.appendMarkdown(state === 'streaming' ? `${entry.text}▌` : entry.text);

      if (state === 'done') {
        if (entry.target.truncated) {
          md.appendMarkdown('\n\n_※ 함수가 길어 앞부분만 분석했습니다._');
        }
        md.appendMarkdown(`\n\n${this.footer(entry, true)}`);
      }
    }

    entry.thread.comments = [
      {
        body: md,
        mode: vscode.CommentMode.Preview,
        author: { name: 'Snoop' },
      },
    ];
  }

  /**
   * 하단 액션 링크. 데코레이션과 달리 위젯 안에서 클릭이 된다.
   *
   * 완료 상태에는 재분석 링크를 넣지 않는다. 결과가 캐시돼 있어서
   * 다시 눌러도 재요청 없이 같은 텍스트가 그대로 나온다.
   * 반면 에러는 캐시되지 않으므로 재시도가 실제로 다시 요청한다.
   *
   * 코디콘($(refresh) 등)은 워크벤치 CSS 가 세로 정렬을 잡는데 확장에서
   * 손댈 수 없다. 본문과 같은 폰트로 렌더되는 텍스트 글리프를 쓰면
   * 베이스라인에 그대로 앉으므로 정렬이 어긋나지 않는다.
   */
  private footer(entry: Entry, done: boolean): string {
    const dismiss = encodeURIComponent(JSON.stringify(entry.key));
    const close = `[✕ 닫기](command:snoop.dismissComment?${dismiss})`;

    if (done) {
      return `---\n\n${close}`;
    }

    const explain = encodeURIComponent(JSON.stringify(entry.target.explainArgs));
    return (
      `---\n\n` +
      `[↻ 다시 시도](command:snoop.explain?${explain}) · ${close}`
    );
  }
}
