import { css } from "../../../component-styles";

import { LineStream } from "./string-stream";
import type { Tokenizer } from "./tokenizer";

// Highlighting outside an editor: run a tokenizer over a string and colour
// the spans with the same --fg-syntax-* roles std-code uses.

export type SyntaxRole =
  | "keyword"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "punctuation"
  | "operator";

export type SyntaxSpan = { from: number; to: number; role: SyntaxRole };

/** The colour role for a tokenizer's tag name, or none (plain text). */
export function syntaxRole(type: Option<string>): Option<SyntaxRole> {
  if (type == null) return null;
  const tag = type.split(" ")[0];
  if (tag === "variableName.function") return "function";
  const base = tag.split(".")[0];
  switch (base) {
    case "keyword":
      return "keyword";
    case "string":
      return "string";
    case "number":
    case "bool":
    case "atom":
      return "number";
    case "comment":
    case "lineComment":
      return "comment";
    case "punctuation":
    case "attributeName":
      return "punctuation";
    case "operator":
      return "operator";
    default:
      return null;
  }
}

/** Coloured spans of `text`, one line at a time with state carried over. */
export function highlightText<S>(tokenizer: Tokenizer<S>, text: string): SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  const state = tokenizer.startState(2);
  let offset = 0;
  for (const line of text.split("\n")) {
    const stream = new LineStream(line);
    let stalls = 0;
    while (!stream.eol()) {
      stream.start = stream.pos;
      const type = tokenizer.token(stream, state);
      if (stream.pos === stream.start) {
        // A state-only call; a tokenizer that never advances is skipped past.
        if (++stalls > 3) stream.next();
        continue;
      }
      stalls = 0;
      const role = syntaxRole(type);
      if (role != null) {
        spans.push({ from: offset + stream.start, to: offset + stream.pos, role });
      }
    }
    offset += line.length + 1;
  }
  return spans;
}

/** Colours for `tok-<role>` classes, from the --fg-syntax-* tokens. */
export const SYNTAX_TOKEN_STYLE = css`
  .tok-keyword { color: var(--fg-syntax-keyword); }
  .tok-function { color: var(--fg-syntax-function); }
  .tok-string { color: var(--fg-syntax-string); }
  .tok-number { color: var(--fg-syntax-number); }
  .tok-comment { color: var(--fg-syntax-comment); }
  .tok-punctuation { color: var(--fg-syntax-punctuation); }
  .tok-operator { color: var(--fg-syntax-operator); }
`;
