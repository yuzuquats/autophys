// Shared shapes for the review-note DSL family (```review-* fences in commit
// notes). Parsers are forgiving — mermaid-style noise is skipped, genuinely
// unparseable lines fail with a 1-based fence-body line number — and callers
// degrade a failed parse to the plain code block, so strictness costs nothing
// and makes typos visible. Pure, DOM-free: deno-testable.

export namespace ReviewDsl {
  export type Err = { line: number; message: string };

  export type Result<T> = { ok: true; value: T } | { ok: false; error: Err };

  export function ok<T>(value: T): Result<T> {
    return { ok: true, value };
  }

  export function err<T>(line: number, message: string): Result<T> {
    return { ok: false, error: { line, message } };
  }

  export type Line = { text: string; line: number };

  /** Split a fence body into significant lines: strips `%%` comments and
   * blanks; `line` is the 1-based position in the original body so parser
   * errors point at what the author wrote. */
  export function lines(src: string): Line[] {
    const out: Line[] = [];
    const raw = src.split("\n");
    for (let i = 0; i < raw.length; i++) {
      let text = raw[i];
      const comment = text.indexOf("%%");
      if (comment >= 0) text = text.slice(0, comment);
      text = text.trim();
      if (text === "") continue;
      out.push({ text, line: i + 1 });
    }
    return out;
  }

  /** Diagram size caps — review diagrams orient, they don't document. */
  export const MAX_NODES = 25;
  export const MAX_EDGES = 60;

  /** Repo-path heuristic shared by steps anchors and (later) file-ref links:
   * ≥1 slash-separated segment, optional `:line` / `:from-to` suffix. False
   * positives stay harmless — unresolved paths render as plain code. */
  const PATH_RE = /^[\w.@-]+(?:\/[\w.@-]+)+(?::\d+(?:-\d+)?)?$/;

  export function isPathLike(text: string): boolean {
    return PATH_RE.test(text);
  }
}
