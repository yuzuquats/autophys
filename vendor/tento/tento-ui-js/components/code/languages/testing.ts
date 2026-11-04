import { StringStream } from "npm:@codemirror/language@^6";

import type { TokenStream, Tokenizer } from "./tokenizer";

// Test support: run a tokenizer over source the way StreamLanguage does —
// line by line, one state carried through — with CodeMirror's own
// StringStream. Not imported by any page.

export type Token = [text: string, type: string | null];

export function tokenizeLines<S>(tokenizer: Tokenizer<S>, source: string): Token[][] {
  const state = tokenizer.startState(2);
  return source.split("\n").map((line) => {
    const stream = new StringStream(line, 2, 2) as unknown as TokenStream;
    const tokens: Token[] = [];
    let stalls = 0;
    while (!stream.eol()) {
      const start = stream.pos;
      const type = tokenizer.token(stream, state);
      if (stream.pos === start) {
        // CodeMirror retries a call that only changed state; a tokenizer
        // that never advances would loop, so allow a bounded few.
        if (++stalls > 3) throw new Error(`no progress at ${start} in ${line}`);
        continue;
      }
      stalls = 0;
      const text = stream.current();
      if (text.trim() !== "") tokens.push([text, type]);
      stream.start = stream.pos;
    }
    return tokens;
  });
}

/** The type of the first token whose text is `text`, if any. */
export function typeOf(line: readonly Token[], text: string): string | null | undefined {
  return line.find(([t]) => t === text)?.[1];
}
