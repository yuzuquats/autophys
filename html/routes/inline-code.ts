// Inline code on the docs page mixes shell flags, Python calls and Rust signatures, while
// std-documentation colours inline code with one tokenizer. This one picks a language per
// span: std-documentation highlights each inline code span on its own, with fresh state, so
// the first token call sees the whole span and can choose. Spans that read as plain values
// (paths, environment variables, file names, single words) stay uncoloured.
import type { Tokenizer } from "@tento-ui/components/code/languages/tokenizer";
import { pythonTokenizer } from "@tento-ui/components/code/languages/python";
import { shellTokenizer } from "@tento-ui/components/code/languages/shell";
import { rustTokenizer } from "./rust-tokenizer.ts";

type Inner = { tokenizer: Tokenizer<unknown>; state: unknown };
export interface InlineState {
  inner: Option<Inner>;
  chosen: boolean;
}

const RUST = /::|&str|&\[|\b(?:Option|Result|Vec)<|\bfn\s|\blet\s|:\s*Duration\b/;
const FLAGS = /^--?[a-z]/;
const SHELL = /^(?:\$\w|(?:\.{0,2}\/|\.venv\/)\S*\s|(?:cargo|pip|python3?|muse|git|autophys|bench|research)\s)/;
const PYTHON = /^(?:import|from)\s|^@|\w\(|\w=|\s=\s/;

/** Flags and their values, as the option tables write them: `--policy a|b`, `--out DIR`. */
const flagTokenizer: Tokenizer<null> = {
  name: "flags",
  startState: () => null,
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^--?[\w-]+/)) return "attributeName";
    if (stream.match(/^\d[\d.,]*/)) return "number";
    if (stream.eat("|")) return "operator";
    stream.match(/^[^\s|]+/) || stream.next();
    return null;
  },
};

/** The tokenizer for one inline span, or none to leave it plain. */
export function inlineLanguage(text: string): Option<Tokenizer<unknown>> {
  const span = text.trim();
  if (span.includes("://")) return null;
  if (RUST.test(span)) return rustTokenizer as Tokenizer<unknown>;
  if (FLAGS.test(span)) return flagTokenizer as Tokenizer<unknown>;
  if (SHELL.test(span)) return shellTokenizer as Tokenizer<unknown>;
  if (PYTHON.test(span)) return pythonTokenizer as Tokenizer<unknown>;
  return null;
}

export const inlineCodeTokenizer: Tokenizer<InlineState> = {
  name: "autophys-inline",
  startState: () => ({ inner: null, chosen: false }),
  copyState: (state) => ({
    chosen: state.chosen,
    inner: state.inner == null ? null : {
      tokenizer: state.inner.tokenizer,
      state: state.inner.tokenizer.copyState?.(state.inner.state) ?? state.inner.state,
    },
  }),
  token(stream, state) {
    if (!state.chosen) {
      state.chosen = true;
      const tokenizer = inlineLanguage(stream.string);
      state.inner = tokenizer == null ? null : { tokenizer, state: tokenizer.startState(2) };
    }
    if (state.inner == null) {
      stream.skipToEnd();
      return null;
    }
    return state.inner.tokenizer.token(stream, state.inner.state);
  },
};
