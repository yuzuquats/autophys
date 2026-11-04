// A code-block language as a stream tokenizer: a plain object std-code hands
// to CodeMirror's StreamLanguage once the editor bundle has loaded.
//
// Nothing here imports CodeMirror. The editor bundle (codemirror.min.js)
// loads lazily, only on pages with code, and it must be the only copy of
// CodeMirror on the page; a tokenizer is ordinary code that ships with the
// page and only ever calls methods on the stream it is given. So a language
// change ships with the page that registers it, not with the bundle.

/** The part of CodeMirror's StringStream a tokenizer reads. */
export interface TokenStream {
  pos: number;
  start: number;
  string: string;
  eol(): boolean;
  sol(): boolean;
  peek(): string | undefined;
  next(): string | void;
  eat(match: string | RegExp | ((ch: string) => boolean)): string | void;
  eatWhile(match: string | RegExp | ((ch: string) => boolean)): boolean;
  eatSpace(): boolean;
  skipToEnd(): void;
  skipTo(ch: string): boolean | void;
  backUp(n: number): void;
  match(pattern: string, consume?: boolean, caseInsensitive?: boolean): boolean;
  match(pattern: RegExp, consume?: boolean): RegExpMatchArray | null;
  current(): string;
}

/**
 * A stream tokenizer, shaped like CodeMirror's StreamParser. `token` returns
 * a highlight tag name ("keyword", "string", "variableName.function", …) or
 * null, and must advance the stream or change the state on every call.
 */
export interface Tokenizer<State> {
  name?: string;
  startState(indentUnit: number): State;
  copyState?(state: State): State;
  token(stream: TokenStream, state: State): string | null;
  languageData?: { [name: string]: unknown };
}
