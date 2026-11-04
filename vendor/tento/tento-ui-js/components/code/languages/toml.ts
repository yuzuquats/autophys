import type { Tokenizer } from "./tokenizer";

// TOML, for `toml` fences: tables, keys, strings, numbers and booleans.

type TomlState = { multiline: Option<'"' | "'"> };

export const tomlTokenizer: Tokenizer<TomlState> = {
  name: "toml",
  startState: () => ({ multiline: null }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (state.multiline != null) {
      const close = state.multiline.repeat(3);
      if (stream.skipTo(close)) {
        stream.match(close);
        state.multiline = null;
      } else {
        stream.skipToEnd();
      }
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.sol() && stream.match(/^\[\[?[^\]]*\]\]?/)) return "keyword";
    if (stream.match(/^("""|''')/)) {
      state.multiline = stream.current()[0] as '"' | "'";
      return "string";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) {
      return "string";
    }
    if (stream.match(/^(?:true|false)\b/)) return "bool";
    if (stream.match(/^[+-]?(?:[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?|inf|nan)\b/)) {
      return "number";
    }
    if (stream.match(/^[A-Za-z0-9_.-]+(?=\s*=)/)) return "propertyName";
    if (stream.match(/^[=,[\]{}]/)) return "punctuation";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};
