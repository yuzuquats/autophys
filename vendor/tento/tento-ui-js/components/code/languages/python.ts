import type { Tokenizer, TokenStream } from "./tokenizer";

const KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
const BUILTINS = new Set([
  "abs",
  "all",
  "any",
  "bool",
  "bytes",
  "dict",
  "enumerate",
  "filter",
  "float",
  "int",
  "isinstance",
  "len",
  "list",
  "map",
  "max",
  "min",
  "next",
  "object",
  "open",
  "print",
  "range",
  "repr",
  "reversed",
  "round",
  "set",
  "sorted",
  "str",
  "sum",
  "super",
  "tuple",
  "type",
  "zip",
]);

export interface PythonState {
  delimiter: Option<string>;
  definition: boolean;
}

function quoted(stream: TokenStream, state: PythonState): string {
  const delimiter = state.delimiter;
  if (delimiter == null) return "string";
  while (!stream.eol()) {
    if (stream.match(delimiter)) {
      state.delimiter = null;
      return "string";
    }
    if (stream.next() === "\\") {
      if (stream.eol()) return "string";
      stream.next();
    }
  }
  if (delimiter.length === 1) state.delimiter = null;
  return "string";
}

/** Python highlighting for read-only examples and the shared stream editor. */
export const pythonTokenizer: Tokenizer<PythonState> = {
  name: "python",
  startState: () => ({ delimiter: null, definition: false }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (state.delimiter != null) return quoted(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.eat("#")) {
      stream.skipToEnd();
      return "lineComment";
    }
    const string = stream.match(/^(?:[rubf]|br|rb|fr|rf)?("""|'''|'|")/i);
    if (string != null) {
      state.delimiter = string[1];
      return quoted(stream, state);
    }
    if (
      stream.match(
        /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)[jJ]?/,
      )
    ) return "number";
    const name = stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (name != null) {
      const word = name[0];
      if (KEYWORDS.has(word)) {
        state.definition = word === "def" || word === "class";
        return "keyword";
      }
      if (state.definition) {
        state.definition = false;
        return "variableName.function";
      }
      if (word === "True" || word === "False" || word === "None") return "atom";
      if (
        BUILTINS.has(word) || /^\s*\(/.test(stream.string.slice(stream.pos))
      ) return "variableName.function";
      return "variableName";
    }
    if (
      stream.match(/^(?:\*\*|\/\/|<<|>>|:=|==|!=|<=|>=|[-+*/%@&|^~<>:=])=?/)
    ) return "operator";
    if (stream.match(/^[()[\]{},.;]/)) return "punctuation";
    stream.next();
    return null;
  },
};
