// Rust highlighting for the landing docs' read-only examples. tento-ui ships shell, Python
// and TOML tokenizers but no Rust one, so this lives beside the docs page in the same
// Tokenizer shape; it can move into tento-ui's code/languages unchanged if another app
// needs it.
import type { Tokenizer, TokenStream } from "@tento-ui/components/code/languages/tokenizer";

const KEYWORDS = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
  "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut",
  "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "type",
  "unsafe", "use", "where", "while",
]);

export interface RustState {
  /** Open block comments (Rust's nest). */
  comment: number;
  /** The closing quote of an open string: `"` or `"` followed by a raw string's hashes. */
  delimiter: Option<string>;
  /** The open string is raw (`r"…"`, `r#"…"#`): backslashes are literal. */
  raw: boolean;
  /** The previous word was `fn`, so this one names a function. */
  definition: boolean;
}

function blockComment(stream: TokenStream, state: RustState): string {
  while (!stream.eol() && state.comment > 0) {
    if (stream.match("/*")) state.comment++;
    else if (stream.match("*/")) state.comment--;
    else stream.next();
  }
  return "comment";
}

function quoted(stream: TokenStream, state: RustState): string {
  const delimiter = state.delimiter!;
  while (!stream.eol()) {
    if (stream.match(delimiter)) {
      state.delimiter = null;
      return "string";
    }
    if (stream.next() === "\\" && !state.raw && !stream.eol()) stream.next();
  }
  return "string";
}

export const rustTokenizer: Tokenizer<RustState> = {
  name: "rust",
  startState: () => ({ comment: 0, delimiter: null, raw: false, definition: false }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (state.comment > 0) return blockComment(stream, state);
    if (state.delimiter != null) return quoted(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match("/*")) {
      state.comment = 1;
      return blockComment(stream, state);
    }
    const raw = stream.match(/^b?r(#*)"/);
    if (raw != null) {
      state.delimiter = "\"" + raw[1];
      state.raw = true;
      return quoted(stream, state);
    }
    if (stream.match(/^b?"/)) {
      state.delimiter = "\"";
      state.raw = false;
      return quoted(stream, state);
    }
    if (stream.match(/^b?'(?:\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F]+\}|.)|[^\\'])'/)) return "string";
    if (stream.match(/^'[\p{L}_][\p{L}\p{N}_]*/u)) return "keyword"; // a lifetime
    if (stream.match(/^#!?\[/)) {
      // An attribute: draw it up to its closing bracket, which suits one-line attributes.
      stream.skipTo("]") ? stream.next() : stream.skipToEnd();
      return "attributeName";
    }
    if (
      stream.match(
        /^(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?[\d_]+)?)(?:[iu](?:8|16|32|64|128|size)|f32|f64)?/,
      )
    ) return "number";
    const name = stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (name != null) {
      const word = name[0];
      if (KEYWORDS.has(word)) {
        state.definition = word === "fn";
        return "keyword";
      }
      if (state.definition) {
        state.definition = false;
        return "variableName.function";
      }
      if (word === "true" || word === "false" || word === "None") return "atom";
      if (stream.eat("!")) return "variableName.function"; // a macro call
      if (/^\s*(?:::<[^>]*>)?\s*\(/.test(stream.string.slice(stream.pos))) {
        return "variableName.function";
      }
      return "variableName";
    }
    if (stream.match(/^(?:::|->|=>|&&|\|\||<<|>>|[-+*/%&|^!<>=]=?|\?)/)) return "operator";
    if (stream.match(/^[()[\]{},.;:]/)) return "punctuation";
    stream.next();
    return null;
  },
};
