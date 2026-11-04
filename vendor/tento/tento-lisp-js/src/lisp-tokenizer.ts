// Lisp Tokenizer Implementation with Common Lisp conventions
// Optimized version (LispTokenizer) and unoptimized version (SlowLispTokenizer)

// Token types following Common Lisp conventions
export enum TokenType {
  LEFT_PAREN = "LEFT_PAREN",
  RIGHT_PAREN = "RIGHT_PAREN",
  QUOTE = "QUOTE", // Single quote operator
  STRING = "STRING", // Double-quoted string literal
  NUMBER = "NUMBER", // Integer or float
  SYMBOL = "SYMBOL", // Identifier/symbol
  TAGGED_STRING = "TAGGED_STRING", // Backtick strings like json`{}`
  LEFT_BRACKET = "LEFT_BRACKET", // [ for vectors
  RIGHT_BRACKET = "RIGHT_BRACKET", // ] for vectors
  LEFT_BRACE = "LEFT_BRACE", // { for maps
  RIGHT_BRACE = "RIGHT_BRACE", // } for maps
  EOF = "EOF", // End of input
}

export interface Token {
  type: TokenType;
  value: string | number;
  position: number; // Start position in source
  length: number; // Length of token in source
  line: number; // Line number for error reporting
  column: number; // Column number for error reporting
}

export class TokenizerError extends Error {
  constructor(
    message: string,
    public position: number,
    public line: number,
    public column: number,
  ) {
    super(`${message} at line ${line}, column ${column}`);
    this.name = "TokenizerError";
  }
}

// ============================================================================
// SlowLispTokenizer - Unoptimized, straightforward implementation
// ============================================================================

export class SlowLispTokenizer {
  private position: number = 0;
  private line: number = 1;
  private column: number = 1;
  private readonly input: string;
  private readonly length: number;

  constructor(input: string) {
    this.input = input;
    this.length = input.length;
  }

  public tokenize(): Token[] {
    const tokens: Token[] = [];

    while (!this.isEOF()) {
      const token = this.nextToken();
      if (token) {
        tokens.push(token);
      }
    }

    tokens.push(this.makeToken(TokenType.EOF, "", 0));
    return tokens;
  }

  private nextToken(): Token | null {
    this.skipWhitespace();

    if (this.isEOF()) {
      return null;
    }

    const startPos = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.peek();

    // Single-character tokens
    if (ch === "(") {
      this.advance();
      return this.makeTokenAt(
        TokenType.LEFT_PAREN,
        "(",
        startPos,
        1,
        startLine,
        startColumn,
      );
    }

    if (ch === ")") {
      this.advance();
      return this.makeTokenAt(
        TokenType.RIGHT_PAREN,
        ")",
        startPos,
        1,
        startLine,
        startColumn,
      );
    }

    if (ch === "'") {
      // Quote operator (not string delimiter)
      this.advance();
      return this.makeTokenAt(
        TokenType.QUOTE,
        "'",
        startPos,
        1,
        startLine,
        startColumn,
      );
    }

    if (ch === "[") {
      // Left bracket for vectors
      this.advance();
      return this.makeTokenAt(
        TokenType.LEFT_BRACKET,
        "[",
        startPos,
        1,
        startLine,
        startColumn,
      );
    }

    if (ch === "]") {
      // Right bracket for vectors
      this.advance();
      return this.makeTokenAt(
        TokenType.RIGHT_BRACKET,
        "]",
        startPos,
        1,
        startLine,
        startColumn,
      );
    }

    if (ch === "{") {
      // Left brace for maps
      this.advance();
      return this.makeTokenAt(
        TokenType.LEFT_BRACE,
        "{",
        startPos,
        1,
        startLine,
        startColumn,
      );
    }

    if (ch === "}") {
      // Right brace for maps
      this.advance();
      return this.makeTokenAt(
        TokenType.RIGHT_BRACE,
        "}",
        startPos,
        1,
        startLine,
        startColumn,
      );
    }

    if (ch === '"') {
      // String literal
      return this.readString();
    }

    if (ch === ";") {
      // Comment - skip to end of line
      this.skipComment();
      return this.nextToken();
    }

    // Number, symbol, or tagged string
    if (this.isDigit(ch) || (ch === "-" && this.isDigit(this.peekNext()))) {
      return this.readNumber();
    } else {
      return this.readSymbolOrTagged();
    }
  }

  private readString(): Token {
    const startPos = this.position;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip opening quote
    let value = "";

    while (!this.isEOF() && this.peek() !== '"') {
      if (this.peek() === "\\") {
        // Handle escape sequence
        this.advance();
        if (this.isEOF()) {
          throw new TokenizerError(
            "Unterminated string literal",
            this.position,
            this.line,
            this.column,
          );
        }

        const escaped = this.peek();
        switch (escaped) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "r":
            value += "\r";
            break;
          case "\\":
            value += "\\";
            break;
          case '"':
            value += '"';
            break;
          case "'":
            value += "'";
            break;
          case "0":
            value += "\0";
            break;
          case "b":
            value += "\b";
            break;
          case "f":
            value += "\f";
            break;
          case "v":
            value += "\v";
            break;
          default:
            // For unknown escapes, keep the literal character
            value += escaped;
        }
        this.advance();
      } else {
        value += this.peek();
        this.advance();
      }
    }

    if (this.isEOF()) {
      throw new TokenizerError(
        "Unterminated string literal",
        startPos,
        startLine,
        startColumn,
      );
    }

    this.advance(); // Skip closing quote

    return this.makeTokenAt(
      TokenType.STRING,
      value,
      startPos,
      this.position - startPos,
      startLine,
      startColumn,
    );
  }

  private readNumber(): Token {
    const startPos = this.position;
    const startLine = this.line;
    const startColumn = this.column;
    let value = "";

    // Handle negative numbers
    if (this.peek() === "-") {
      value += this.peek();
      this.advance();
    }

    // Read integer part
    while (!this.isEOF() && this.isDigit(this.peek())) {
      value += this.peek();
      this.advance();
    }

    // Check for decimal point
    if (!this.isEOF() && this.peek() === "." && this.isDigit(this.peekNext())) {
      value += this.peek();
      this.advance();

      // Read decimal part
      while (!this.isEOF() && this.isDigit(this.peek())) {
        value += this.peek();
        this.advance();
      }
    }

    // Check for scientific notation
    if (!this.isEOF() && (this.peek() === "e" || this.peek() === "E")) {
      const nextChar = this.peekNext();
      if (this.isDigit(nextChar) || nextChar === "+" || nextChar === "-") {
        value += this.peek();
        this.advance();

        if (this.peek() === "+" || this.peek() === "-") {
          value += this.peek();
          this.advance();
        }

        while (!this.isEOF() && this.isDigit(this.peek())) {
          value += this.peek();
          this.advance();
        }
      }
    }

    const num = Number.parseFloat(value);
    if (Number.isNaN(num)) {
      throw new TokenizerError(
        `Invalid number: ${value}`,
        startPos,
        startLine,
        startColumn,
      );
    }

    return this.makeTokenAt(
      TokenType.NUMBER,
      num,
      startPos,
      this.position - startPos,
      startLine,
      startColumn,
    );
  }

  private readSymbolOrTagged(): Token {
    const startPos = this.position;
    const startLine = this.line;
    const startColumn = this.column;

    // Bare leading backtick is an error — under the tagged-string
    // spec a `\`` only opens a payload after a tag name.
    if (this.peek() === "`") {
      throw new TokenizerError(
        "unexpected character: `",
        startPos,
        startLine,
        startColumn,
      );
    }

    let value = "";

    // Read until we hit a delimiter
    while (!this.isEOF()) {
      const ch = this.peek();

      // Check for regular delimiters (brackets are now delimiters)
      if (this.isDelimiter(ch)) {
        break;
      }

      value += ch;
      this.advance();

      // Check for tagged string (backtick)
      if (this.peek() === "`") {
        return this.readTaggedString(value, startPos, startLine, startColumn);
      }
    }

    return this.makeTokenAt(
      TokenType.SYMBOL,
      value,
      startPos,
      this.position - startPos,
      startLine,
      startColumn,
    );
  }

  private readTaggedString(
    tag: string,
    startPos: number,
    startLine: number,
    startColumn: number,
  ): Token {
    this.advance(); // Skip first backtick

    // Triple-backtick form: `\`\`\`payload\`\`\`` allows embedded
    // single backticks. Detect by checking for two more consecutive
    // backticks immediately after the opener.
    if (this.peek() === "`" && this.peekNext() === "`") {
      this.advance(); // skip second `
      this.advance(); // skip third `
      let content = "";
      while (!this.isEOF()) {
        // Look for closing `\`\`\``.
        if (
          this.peek() === "`" &&
          this.peekNext() === "`" &&
          this.peekAt(2) === "`"
        ) {
          this.advance();
          this.advance();
          this.advance();
          return this.makeTokenAt(
            TokenType.TAGGED_STRING,
            `${tag}\`\`\`${content}\`\`\``,
            startPos,
            this.position - startPos,
            startLine,
            startColumn,
          );
        }
        content += this.peek();
        this.advance();
      }
      throw new TokenizerError(
        "Unterminated tagged string (long form)",
        startPos,
        startLine,
        startColumn,
      );
    }

    // Short form: scans to first closing backtick. No escapes.
    let content = "";
    while (!this.isEOF() && this.peek() !== "`") {
      content += this.peek();
      this.advance();
    }

    if (this.isEOF()) {
      throw new TokenizerError(
        "Unterminated tagged string",
        startPos,
        startLine,
        startColumn,
      );
    }

    this.advance(); // Skip closing backtick

    return this.makeTokenAt(
      TokenType.TAGGED_STRING,
      `${tag}\`${content}\``,
      startPos,
      this.position - startPos,
      startLine,
      startColumn,
    );
  }


  private skipWhitespace(): void {
    while (!this.isEOF() && this.isWhitespace(this.peek())) {
      if (this.peek() === "\n") {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.position++;
    }
  }

  private skipComment(): void {
    while (!this.isEOF() && this.peek() !== "\n") {
      this.advance();
    }
    if (this.peek() === "\n") {
      this.advance();
    }
  }

  private advance(): void {
    if (this.peek() === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    this.position++;
  }

  private peek(): string {
    return this.input[this.position];
  }

  private peekNext(): string {
    return this.position + 1 < this.length
      ? this.input[this.position + 1]
      : "\0";
  }

  private peekAt(offset: number): string {
    return this.position + offset < this.length
      ? this.input[this.position + offset]
      : "\0";
  }

  private isEOF(): boolean {
    return this.position >= this.length;
  }

  private isWhitespace(ch: string): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }

  private isDelimiter(ch: string): boolean {
    return (
      this.isWhitespace(ch) ||
      ch === "(" ||
      ch === ")" ||
      ch === "[" ||
      ch === "]" ||
      ch === "{" ||
      ch === "}" ||
      ch === '"' ||
      ch === "'" ||
      ch === ";"
    );
  }

  private makeToken(
    type: TokenType,
    value: string | number,
    length: number,
  ): Token {
    return this.makeTokenAt(
      type,
      value,
      this.position - length,
      length,
      this.line,
      this.column - length,
    );
  }

  private makeTokenAt(
    type: TokenType,
    value: string | number,
    position: number,
    length: number,
    line: number,
    column: number,
  ): Token {
    return { type, value, position, length, line, column };
  }
}

// ============================================================================
// LispTokenizer - Optimized implementation
// ============================================================================

// Pre-computed lookup tables for O(1) character classification
const CHAR_CODES = {
  TAB: 9,
  LF: 10,
  CR: 13,
  SPACE: 32,
  QUOTE: 39,
  LPAREN: 40,
  RPAREN: 41,
  PLUS: 43,
  MINUS: 45,
  DOT: 46,
  ZERO: 48,
  NINE: 57,
  SEMICOLON: 59,
  BACKSLASH: 92,
  BACKTICK: 96,
  LBRACKET: 91,
  RBRACKET: 93,
  LBRACE: 123,
  RBRACE: 125,
  DQUOTE: 34,
  LOWER_E: 101,
  UPPER_E: 69,
} as const;

// Lookup table for whitespace (faster than multiple comparisons)
const WHITESPACE = new Uint8Array(128);
WHITESPACE[CHAR_CODES.SPACE] = 1;
WHITESPACE[CHAR_CODES.TAB] = 1;
WHITESPACE[CHAR_CODES.LF] = 1;
WHITESPACE[CHAR_CODES.CR] = 1;

// Lookup table for digits
const DIGITS = new Uint8Array(128);
for (let i = CHAR_CODES.ZERO; i <= CHAR_CODES.NINE; i++) {
  DIGITS[i] = 1;
}

// Escape sequence lookup table
const ESCAPE_CHARS = new Map<number, string>([
  [110, "\n"], // n
  [116, "\t"], // t
  [114, "\r"], // r
  [92, "\\"], // \
  [34, '"'], // "
  [39, "'"], // '
  [48, "\0"], // 0
  [98, "\b"], // b
  [102, "\f"], // f
  [118, "\v"], // v
]);

export class LispTokenizer {
  private pos: number = 0;
  private line: number = 1;
  private col: number = 1;
  private readonly src: string;
  private readonly len: number;
  private readonly tokens: Token[] = [];

  // String builder for efficient string concatenation
  private readonly strBuilder: string[] = [];
  private strBuilderLen: number = 0;

  constructor(input: string) {
    this.src = input;
    this.len = input.length;
  }

  public tokenize(): Token[] {
    while (this.pos < this.len) {
      this.skipWhitespaceOptimized();
      if (this.pos >= this.len) break;

      const token = this.nextTokenOptimized();
      if (token) {
        this.tokens.push(token);
      }
    }

    this.tokens.push({
      type: TokenType.EOF,
      value: "",
      position: this.pos,
      length: 0,
      line: this.line,
      column: this.col,
    });

    return this.tokens;
  }

  private nextTokenOptimized(): Token | null {
    const startPos = this.pos;
    const startLine = this.line;
    const startCol = this.col;
    const charCode = this.src.charCodeAt(this.pos);

    // Use switch for single-character tokens (faster than if-else chain)
    switch (charCode) {
      case CHAR_CODES.LPAREN:
        this.pos++;
        this.col++;
        return {
          type: TokenType.LEFT_PAREN,
          value: "(",
          position: startPos,
          length: 1,
          line: startLine,
          column: startCol,
        };

      case CHAR_CODES.RPAREN:
        this.pos++;
        this.col++;
        return {
          type: TokenType.RIGHT_PAREN,
          value: ")",
          position: startPos,
          length: 1,
          line: startLine,
          column: startCol,
        };

      case CHAR_CODES.QUOTE:
        this.pos++;
        this.col++;
        return {
          type: TokenType.QUOTE,
          value: "'",
          position: startPos,
          length: 1,
          line: startLine,
          column: startCol,
        };

      case CHAR_CODES.LBRACKET:
        this.pos++;
        this.col++;
        return {
          type: TokenType.LEFT_BRACKET,
          value: "[",
          position: startPos,
          length: 1,
          line: startLine,
          column: startCol,
        };

      case CHAR_CODES.RBRACKET:
        this.pos++;
        this.col++;
        return {
          type: TokenType.RIGHT_BRACKET,
          value: "]",
          position: startPos,
          length: 1,
          line: startLine,
          column: startCol,
        };

      case CHAR_CODES.LBRACE:
        this.pos++;
        this.col++;
        return {
          type: TokenType.LEFT_BRACE,
          value: "{",
          position: startPos,
          length: 1,
          line: startLine,
          column: startCol,
        };

      case CHAR_CODES.RBRACE:
        this.pos++;
        this.col++;
        return {
          type: TokenType.RIGHT_BRACE,
          value: "}",
          position: startPos,
          length: 1,
          line: startLine,
          column: startCol,
        };

      case CHAR_CODES.DQUOTE:
        return this.readStringOptimized(startPos, startLine, startCol);

      case CHAR_CODES.SEMICOLON:
        this.skipCommentOptimized();
        return null;

      case CHAR_CODES.BACKTICK:
        // Bare leading backtick is an error — under the
        // tagged-string spec, `\`` only opens a payload after a
        // tag name.
        throw new TokenizerError(
          "unexpected character: `",
          startPos,
          startLine,
          startCol,
        );
    }

    // Number detection (optimized)
    if (
      DIGITS[charCode] ||
      (charCode === CHAR_CODES.MINUS &&
        this.pos + 1 < this.len &&
        DIGITS[this.src.charCodeAt(this.pos + 1)])
    ) {
      return this.readNumberOptimized(startPos, startLine, startCol);
    }

    // Symbol or tagged string
    return this.readSymbolOrTaggedOptimized(startPos, startLine, startCol);
  }

  private readStringOptimized(
    startPos: number,
    startLine: number,
    startCol: number,
  ): Token {
    this.pos++; // Skip opening quote
    this.col++;

    // Clear string builder
    this.strBuilderLen = 0;

    while (this.pos < this.len) {
      const charCode = this.src.charCodeAt(this.pos);

      if (charCode === CHAR_CODES.DQUOTE) {
        this.pos++;
        this.col++;

        // Build final string from array
        const value =
          this.strBuilderLen > 0
            ? this.strBuilder.slice(0, this.strBuilderLen).join("")
            : "";

        return {
          type: TokenType.STRING,
          value,
          position: startPos,
          length: this.pos - startPos,
          line: startLine,
          column: startCol,
        };
      }

      if (charCode === CHAR_CODES.BACKSLASH) {
        this.pos++;
        this.col++;

        if (this.pos >= this.len) {
          throw new TokenizerError(
            "Unterminated string literal",
            this.pos,
            this.line,
            this.col,
          );
        }

        const nextCharCode = this.src.charCodeAt(this.pos);
        const escaped = ESCAPE_CHARS.get(nextCharCode);

        if (escaped !== undefined) {
          this.strBuilder[this.strBuilderLen++] = escaped;
        } else {
          // Unknown escape, keep literal
          this.strBuilder[this.strBuilderLen++] = this.src[this.pos];
        }

        this.pos++;
        this.col++;
      } else {
        this.strBuilder[this.strBuilderLen++] = this.src[this.pos];

        if (charCode === CHAR_CODES.LF) {
          this.line++;
          this.col = 1;
        } else {
          this.col++;
        }
        this.pos++;
      }
    }

    throw new TokenizerError(
      "Unterminated string literal",
      startPos,
      startLine,
      startCol,
    );
  }

  private readNumberOptimized(
    startPos: number,
    startLine: number,
    startCol: number,
  ): Token {
    let endPos = this.pos;

    // Handle negative
    if (this.src.charCodeAt(endPos) === CHAR_CODES.MINUS) {
      endPos++;
    }

    // Read integer part
    while (endPos < this.len && DIGITS[this.src.charCodeAt(endPos)]) {
      endPos++;
    }

    // Check for decimal
    if (
      endPos < this.len &&
      this.src.charCodeAt(endPos) === CHAR_CODES.DOT &&
      endPos + 1 < this.len &&
      DIGITS[this.src.charCodeAt(endPos + 1)]
    ) {
      endPos++; // Skip dot
      while (endPos < this.len && DIGITS[this.src.charCodeAt(endPos)]) {
        endPos++;
      }
    }

    // Check for scientific notation
    if (endPos < this.len) {
      const charCode = this.src.charCodeAt(endPos);
      if (charCode === CHAR_CODES.LOWER_E || charCode === CHAR_CODES.UPPER_E) {
        const nextPos = endPos + 1;
        if (nextPos < this.len) {
          const nextCode = this.src.charCodeAt(nextPos);
          if (
            DIGITS[nextCode] ||
            nextCode === CHAR_CODES.PLUS ||
            nextCode === CHAR_CODES.MINUS
          ) {
            endPos = nextPos;
            if (!DIGITS[nextCode]) {
              endPos++; // Skip +/-
            }
            while (endPos < this.len && DIGITS[this.src.charCodeAt(endPos)]) {
              endPos++;
            }
          }
        }
      }
    }

    const numStr = this.src.substring(this.pos, endPos);
    const num = +numStr; // Faster than parseFloat

    if (Number.isNaN(num)) {
      throw new TokenizerError(
        `Invalid number: ${numStr}`,
        startPos,
        startLine,
        startCol,
      );
    }

    // Update position
    const length = endPos - this.pos;
    this.col += length;
    this.pos = endPos;

    return {
      type: TokenType.NUMBER,
      value: num,
      position: startPos,
      length: endPos - startPos,
      line: startLine,
      column: startCol,
    };
  }

  private readSymbolOrTaggedOptimized(
    startPos: number,
    startLine: number,
    startCol: number,
  ): Token {
    let endPos = this.pos;

    // Read until delimiter
    while (endPos < this.len) {
      const charCode = this.src.charCodeAt(endPos);

      // Quick delimiter check (now includes brackets and braces)
      if (
        charCode < 128 &&
        (WHITESPACE[charCode] ||
          charCode === CHAR_CODES.LPAREN ||
          charCode === CHAR_CODES.RPAREN ||
          charCode === CHAR_CODES.LBRACKET ||
          charCode === CHAR_CODES.RBRACKET ||
          charCode === CHAR_CODES.LBRACE ||
          charCode === CHAR_CODES.RBRACE ||
          charCode === CHAR_CODES.DQUOTE ||
          charCode === CHAR_CODES.QUOTE ||
          charCode === CHAR_CODES.SEMICOLON)
      ) {
        break;
      }

      endPos++;

      // Check for tagged string
      if (
        endPos < this.len &&
        this.src.charCodeAt(endPos) === CHAR_CODES.BACKTICK
      ) {
        const tag = this.src.substring(this.pos, endPos);
        this.pos = endPos;
        this.col += tag.length;
        return this.readTaggedStringOptimized(
          tag,
          startPos,
          startLine,
          startCol,
        );
      }
    }

    const value = this.src.substring(this.pos, endPos);
    const length = endPos - this.pos;
    this.col += length;
    this.pos = endPos;

    return {
      type: TokenType.SYMBOL,
      value,
      position: startPos,
      length: endPos - startPos,
      line: startLine,
      column: startCol,
    };
  }


  private readTaggedStringOptimized(
    tag: string,
    startPos: number,
    startLine: number,
    startCol: number,
  ): Token {
    // Skip past the opening backtick
    this.pos++;
    this.col++;

    // Detect triple-backtick form: opener was `\``, look for two
    // more consecutive backticks.
    if (
      this.pos + 1 < this.len &&
      this.src.charCodeAt(this.pos) === CHAR_CODES.BACKTICK &&
      this.src.charCodeAt(this.pos + 1) === CHAR_CODES.BACKTICK
    ) {
      this.pos += 2;
      this.col += 2;
      this.strBuilderLen = 0;
      while (this.pos < this.len) {
        const charCode = this.src.charCodeAt(this.pos);
        // Look for closing `\`\`\``.
        if (
          charCode === CHAR_CODES.BACKTICK &&
          this.pos + 2 < this.len &&
          this.src.charCodeAt(this.pos + 1) === CHAR_CODES.BACKTICK &&
          this.src.charCodeAt(this.pos + 2) === CHAR_CODES.BACKTICK
        ) {
          const content =
            this.strBuilderLen > 0
              ? this.strBuilder.slice(0, this.strBuilderLen).join("")
              : "";
          this.pos += 3;
          this.col += 3;
          return {
            type: TokenType.TAGGED_STRING,
            value: `${tag}\`\`\`${content}\`\`\``,
            position: startPos,
            length: this.pos - startPos,
            line: startLine,
            column: startCol,
          };
        }
        this.strBuilder[this.strBuilderLen++] = this.src[this.pos];
        if (charCode === CHAR_CODES.LF) {
          this.line++;
          this.col = 1;
        } else {
          this.col++;
        }
        this.pos++;
      }
      throw new TokenizerError(
        "Unterminated tagged string (long form)",
        startPos,
        startLine,
        startCol,
      );
    }

    // Short form: scan to first closing backtick. No escapes.
    this.strBuilderLen = 0;
    while (
      this.pos < this.len &&
      this.src.charCodeAt(this.pos) !== CHAR_CODES.BACKTICK
    ) {
      const charCode = this.src.charCodeAt(this.pos);
      this.strBuilder[this.strBuilderLen++] = this.src[this.pos];
      if (charCode === CHAR_CODES.LF) {
        this.line++;
        this.col = 1;
      } else {
        this.col++;
      }
      this.pos++;
    }

    if (this.pos >= this.len) {
      throw new TokenizerError(
        "Unterminated tagged string",
        startPos,
        startLine,
        startCol,
      );
    }

    const content =
      this.strBuilderLen > 0
        ? this.strBuilder.slice(0, this.strBuilderLen).join("")
        : "";

    this.pos++; // Skip closing backtick
    this.col++;

    return {
      type: TokenType.TAGGED_STRING,
      value: `${tag}\`${content}\``,
      position: startPos,
      length: this.pos - startPos,
      line: startLine,
      column: startCol,
    };
  }

  private skipWhitespaceOptimized(): void {
    while (this.pos < this.len) {
      const charCode = this.src.charCodeAt(this.pos);

      if (charCode >= 128 || !WHITESPACE[charCode]) {
        break;
      }

      if (charCode === CHAR_CODES.LF) {
        this.line++;
        this.col = 1;
      } else {
        this.col++;
      }
      this.pos++;
    }
  }

  private skipCommentOptimized(): void {
    // Skip to end of line
    while (
      this.pos < this.len &&
      this.src.charCodeAt(this.pos) !== CHAR_CODES.LF
    ) {
      this.pos++;
      this.col++;
    }

    // Skip the newline if present
    if (this.pos < this.len) {
      this.pos++;
      this.line++;
      this.col = 1;
    }
  }
}
