import type { TokenStream } from "./tokenizer";

/**
 * A TokenStream over one line, for running a tokenizer without CodeMirror —
 * inline code in prose has no editor to hand it one. Mirrors the parts of
 * CodeMirror's StringStream that TokenStream names.
 */
export class LineStream implements TokenStream {
  pos = 0;
  start = 0;

  constructor(public string: string) {}

  eol(): boolean {
    return this.pos >= this.string.length;
  }
  sol(): boolean {
    return this.pos === 0;
  }
  peek(): string | undefined {
    return this.string.charAt(this.pos) || undefined;
  }
  next(): string | void {
    if (this.pos < this.string.length) return this.string.charAt(this.pos++);
  }
  eat(match: string | RegExp | ((ch: string) => boolean)): string | void {
    const ch = this.string.charAt(this.pos);
    const ok =
      typeof match === "string"
        ? ch === match
        : ch !== "" && (match instanceof RegExp ? match.test(ch) : match(ch));
    if (ok) {
      this.pos += 1;
      return ch;
    }
  }
  eatWhile(match: string | RegExp | ((ch: string) => boolean)): boolean {
    const start = this.pos;
    while (this.eat(match)) {
      // consume
    }
    return this.pos > start;
  }
  eatSpace(): boolean {
    const start = this.pos;
    while (/[\s ]/.test(this.string.charAt(this.pos))) this.pos += 1;
    return this.pos > start;
  }
  skipToEnd(): void {
    this.pos = this.string.length;
  }
  skipTo(ch: string): boolean | void {
    const found = this.string.indexOf(ch, this.pos);
    if (found > -1) {
      this.pos = found;
      return true;
    }
  }
  backUp(n: number): void {
    this.pos -= n;
  }
  match(pattern: string, consume?: boolean, caseInsensitive?: boolean): boolean;
  match(pattern: RegExp, consume?: boolean): RegExpMatchArray | null;
  match(
    pattern: string | RegExp,
    consume = true,
    caseInsensitive = false,
  ): boolean | RegExpMatchArray | null {
    if (typeof pattern === "string") {
      const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
      const slice = this.string.substr(this.pos, pattern.length);
      if (fold(slice) !== fold(pattern)) return false;
      if (consume) this.pos += pattern.length;
      return true;
    }
    const match = this.string.slice(this.pos).match(pattern);
    if (match == null || match.index! > 0) return null;
    if (consume) this.pos += match[0].length;
    return match;
  }
  current(): string {
    return this.string.slice(this.start, this.pos);
  }
}
