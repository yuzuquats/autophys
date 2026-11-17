import type { Tokenizer, TokenStream } from "@tento-ui/components/code/languages/tokenizer";

type State = { quote: string | null; comment: boolean };
const keywords = new Set(("as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined unknown var void while yield string number boolean").split(" "));
function string(stream: TokenStream, state: State): string {
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === "\\") stream.next();
    else if (ch === state.quote) { state.quote = null; break; }
  }
  return "string";
}
/** Lightweight stream colouring for read-only JS/TS/JSON examples; not a parser. */
export const scriptTokenizer: Tokenizer<State> = {
  name: "documentation-script",
  startState: () => ({ quote: null, comment: false }),
  copyState: state => ({ ...state }),
  token(stream, state) {
    if (state.comment) {
      while (!stream.eol()) if (stream.match("*/")) { state.comment = false; break; } else stream.next();
      return "comment";
    }
    if (state.quote) return string(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.comment = true; return "comment"; }
    const quote = stream.peek();
    if (quote === '"' || quote === "'" || quote === "`") { stream.next(); state.quote = quote; return string(stream, state); }
    if (stream.match(/^(?:0[xob][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i)) return "number";
    if (stream.match(/^[A-Za-z_$][\w$]*/)) {
      if (keywords.has(stream.current())) return "keyword";
      if (stream.match(/^\s*\(/, false)) return "variableName.function";
      return null;
    }
    if (stream.match(/^[{}()[\],.;:]/)) return "punctuation";
    stream.next();
    return "operator";
  },
};
