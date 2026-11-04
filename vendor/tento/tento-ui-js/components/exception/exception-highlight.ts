// The grammar half of `<std-exception-trace>`: one line of a stack or a
// compiler diagnostic, split into coloured runs.
//
// It lives in its own module with no DOM imports for the reason `review-route`
// does — a grammar buried in a web component can only be tested through a
// browser, so in practice it is not tested at all, and a highlighter that
// silently eats a character is exactly the bug nobody would catch by looking.
// `exception-highlight.deno.test.ts` asserts the totality property directly.

export namespace ExceptionHighlight {
  /** What a run of a failure line means. `text` is everything unclassified. */
  export type TokenKind =
    | "text"
    | "keyword"
    | "severity"
    | "callee"
    | "path"
    | "position"
    | "string";

  export type Token = { kind: TokenKind; text: string };

  /** `at` / `at async` opening a stack frame, or a diagnostic's severity word.
   *  Anchored: `error` in the middle of a sentence is prose, not a label. */
  const HEAD = /^(\s*)(at\s+(?:async\s+)?|(?:error|warning|note|fatal|panicked)\b:?\s*)/i;

  /** `render (` — a callee exists only in a frame, and only when a
   *  parenthesised location follows it. */
  const CALLEE = /^([\w$.<>[\]]+)(\s*\()/;

  /** Quoted literals, then `<path>[:line[:col]]`, then a bare `:line:col` —
   *  what is left when the path was already consumed as a callee's
   *  parenthetical. */
  const SCAN =
    /("[^"\n]*"|'[^'\n]*')|((?:[\w@.~+$-]*\/)*[\w@.~+$-]+\.[A-Za-z][\w]*)((?::\d+)+)?|((?::\d+)+)/g;

  /**
   * Split one line into coloured runs.
   *
   * Pure, total, and order-preserving: concatenating every `text` reproduces
   * the input exactly, so highlighting can never drop or reorder what a
   * compiler said. Deliberately not a real parser — it recognises the four
   * shapes that carry meaning in a failure and leaves everything else alone:
   *
   *     at render (index.root.js:4821:12)
   *     ^^         ^^^^^^        ^^^^^^^^ path, position
   *     |          callee
   *     keyword
   *
   *     error: Could not resolve: "@acme/tokens/color"
   *     ^^^^^^                    ^^^^^^^^^^^^^^^^^^^^ string
   *     severity
   */
  export function tokenize(line: string): Token[] {
    const out: Token[] = [];
    const push = (kind: TokenKind, text: string): void => {
      if (text !== "") out.push({ kind, text });
    };

    let rest = line;
    const head = HEAD.exec(line);
    if (head) {
      const isFrame = head[2].toLowerCase().startsWith("at");
      push("text", head[1]);
      push(isFrame ? "keyword" : "severity", head[2]);
      rest = line.slice(head[0].length);
      const callee = isFrame ? CALLEE.exec(rest) : null;
      if (callee) {
        push("callee", callee[1]);
        push("text", callee[2]);
        rest = rest.slice(callee[0].length);
      }
    }

    SCAN.lastIndex = 0;
    let at = 0;
    for (let m = SCAN.exec(rest); m != null; m = SCAN.exec(rest)) {
      push("text", rest.slice(at, m.index));
      if (m[1] != null) {
        push("string", m[1]);
      } else if (m[2] != null) {
        push("path", m[2]);
        push("position", m[3] ?? "");
      } else {
        push("position", m[4] ?? "");
      }
      at = m.index + m[0].length;
    }
    push("text", rest.slice(at));
    return out;
  }
}
