import type { TokenStream, Tokenizer } from "./tokenizer";

// Bash, for `sh` fences: command names, keywords, flags, variables,
// operators, quotes and `#` comments.

const KEYWORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "return",
  "select",
  "then",
  "until",
  "while",
]);

/** Keywords after which the next word is an argument, not a command. */
const ARGUMENT_KEYWORDS = new Set(["in", "export", "local", "return"]);

export type ShellState = {
  /** The next word is a command name. */
  command: boolean;
  /** An unterminated quote continues on the next line. */
  string: Option<'"' | "'">;
  /** Inside `NAME=value` before a command: the `=` or the value is next. */
  assignment: Option<"=" | "value">;
};

/**
 * A host language that embeds another in a quoted argument (tsh's
 * `tsh '(…)'`) claims a `'` here before bash reads it as a string; it returns
 * the token it took, or null to leave the quote to bash.
 */
export type ShellHooks = {
  singleQuote?: (stream: TokenStream, state: ShellState) => string | null;
  /**
   * A host's interpolation (tsh's `{name}` in `(sh! …)`), tried before each
   * word and inside double quotes; it returns the token it took, or null.
   */
  hole?: (stream: TokenStream) => string | null;
};

export function shellStartState(): ShellState {
  return { command: true, string: null, assignment: null };
}

/** A `$NAME`, `${…}` or `$1` expansion at the stream position. */
const EXPANSION = /^\$(?:\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/;

function consumeQuoted(
  stream: TokenStream,
  quote: '"' | "'",
  state: ShellState,
  hooks: ShellHooks,
): void {
  while (!stream.eol()) {
    if (quote === '"' && stream.pos > stream.start) {
      // Stop before an expansion or a host hole; the next call colours it
      // and the string resumes after.
      if (stream.match(EXPANSION, false) != null || peekHole(stream, hooks)) {
        state.string = quote;
        return;
      }
    }
    const ch = stream.next();
    if (ch === "\\" && quote === '"') {
      stream.next();
      continue;
    }
    if (ch === quote) {
      state.string = null;
      return;
    }
  }
  state.string = quote;
}

const WORD_CHAR = /[^\s'"|&;<>()$`#\\]/;

/**
 * One unquoted word: ordinary characters and backslash escapes (`\(` is a
 * literal paren, not an operator), stopping before a host hole so
 * `build/{name}.txt` colours its hole.
 */
function consumeWord(stream: TokenStream, hooks: ShellHooks): boolean {
  const start = stream.pos;
  while (!stream.eol()) {
    if (stream.pos > start && peekHole(stream, hooks)) break;
    const ch = stream.peek()!;
    if (ch === "\\") {
      stream.next();
      stream.next();
      continue;
    }
    if (!WORD_CHAR.test(ch)) break;
    stream.next();
  }
  return stream.pos > start;
}

/** Whether a host hole starts here, without consuming it. */
function peekHole(stream: TokenStream, hooks: ShellHooks): boolean {
  if (hooks.hole == null) return false;
  const pos = stream.pos;
  const start = stream.start;
  const taken = hooks.hole(stream) != null;
  stream.pos = pos;
  stream.start = start;
  return taken;
}

export function shellToken(
  stream: TokenStream,
  state: ShellState,
  hooks: ShellHooks = {},
): string | null {
  if (state.string != null) {
    if (state.string === '"') {
      const hole = hooks.hole?.(stream) ?? null;
      if (hole != null) return hole;
      if (stream.match(EXPANSION)) return "atom";
    }
    consumeQuoted(stream, state.string, state, hooks);
    return "string";
  }
  if (stream.sol()) state.command = true;
  if (state.assignment === "=") {
    stream.next();
    // `NAME= cmd` assigns the empty string; the command follows.
    const next = stream.peek();
    state.assignment = next == null || /\s/.test(next) ? null : "value";
    return "operator";
  }
  if (state.assignment === "value") {
    // One value word, quoted or not; the command name still follows it.
    state.assignment = null;
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      consumeQuoted(stream, quote, state, hooks);
      return "string";
    }
    if (consumeWord(stream, hooks)) return null;
  }
  if (stream.eatSpace()) return null;
  const ch = stream.peek();
  if (ch == null) return null;

  if (stream.sol() && stream.match(/^\$ /)) return "punctuation";
  const hole = hooks.hole?.(stream) ?? null;
  if (hole != null) {
    state.command = false;
    return hole;
  }
  if (ch === "#") {
    stream.skipToEnd();
    return "lineComment";
  }
  if (ch === "'") {
    const claimed = hooks.singleQuote?.(stream, state) ?? null;
    if (claimed != null) {
      state.command = false;
      return claimed;
    }
  }
  if (ch === "'" || ch === '"') {
    stream.next();
    consumeQuoted(stream, ch, state, hooks);
    state.command = false;
    return "string";
  }
  if (ch === "$") {
    if (stream.match(EXPANSION)) {
      state.command = false;
      return "atom";
    }
    if (stream.match(/^\$\(/)) {
      state.command = true;
      return "operator";
    }
  }
  if (stream.match(/^(?:&&|\|\||;;|[|;&])/)) {
    state.command = true;
    return "operator";
  }
  if (stream.match(/^(?:[0-9]*>>?|<<?|[()])/)) return "operator";
  if (stream.match(/^--?[A-Za-z0-9][\w-]*(?:=)?/)) {
    state.command = false;
    return "attributeName";
  }
  if (state.command && stream.match(/^[A-Za-z_][A-Za-z0-9_]*(?==)/)) {
    // `NAME=value` before a command: the name, then `=`, then the value.
    state.assignment = "=";
    return "atom";
  }
  if (consumeWord(stream, hooks)) {
    const word = stream.current();
    if (KEYWORDS.has(word)) {
      state.command = !ARGUMENT_KEYWORDS.has(word);
      return "keyword";
    }
    if (state.command) {
      state.command = false;
      return "variableName.function";
    }
    if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(word)) return "number";
    return null;
  }
  stream.next();
  return null;
}

export const shellTokenizer: Tokenizer<ShellState> = {
  name: "shell",
  startState: shellStartState,
  copyState: (state) => ({ ...state }),
  token: (stream, state) => shellToken(stream, state),
  languageData: { commentTokens: { line: "#" } },
};
