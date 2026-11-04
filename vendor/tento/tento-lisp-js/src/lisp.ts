import { nonnull } from "@tento-core/assert";
import { LispTokenizer, TokenType } from "./lisp-tokenizer";
import { ControlFlow } from "./ops/control-flow";
import { StandardLibrary } from "./ops/stdlib";
import { BracketNotationUtils } from "./bracket-notation-utils";

// Fast lookup set for arithmetic operators - defined outside namespace for performance
const ARITHMETIC_OPS = new Set(["+", "-", "*", "/", "%", "**", "//"]);

// Cache for fast operator type checking
// const OPERATOR_TYPE_CACHE = new Map<
//   string,
//   "arithmetic" | "stdlib" | "control" | "unknown"
// >();

// Optimization hint bitflags - set during parsing to avoid runtime checks
export enum OptFlags {
  NONE = 0,
  ALL_NUMBERS = 1 << 0, // All arguments are literal numbers
  ARITHMETIC_OP = 1 << 1, // Operator is an arithmetic operation
  NO_EVAL_NEEDED = 1 << 2, // Expression can be computed without evaluation
  SIMPLE_BINARY = 1 << 3, // Simple binary operation (2 args)
  EMPTY_ARGS = 1 << 4, // No arguments provided
  CONSTANT_EXPR = 1 << 5, // Expression is constant and could be pre-computed
}

export namespace Lisp {
  export class CacheMissError extends Error {}

  export type Atom = string | number | object | Procedure | boolean;
  export type Procedure = (args: Atom[], env: Environment) => Atom;
  export type Expression = Atom | Expression[] | OptimizedExpression;
  export type EvalCount = {
    n: number;
  };

  // Optimized expression that carries optimization hints
  export class OptimizedExpression {
    constructor(
      public expr: (Atom | Expression)[],
      public flags: number = OptFlags.NONE,
    ) {}
  }

  // StringLiteral wrapper to distinguish from symbols
  export class StringLiteral {
    constructor(public value: string) {}
  }

  /**
   * Tagged-string semantics:
   * - `json\`payload\`` is sugar — `JSON.parse(payload)` is returned
   *   directly. Parse errors propagate (no silent fallback).
   * - Other tags evaluate to a 2-element list `[tag, payload]` —
   *   uniform structural representation, queryable via list ops.
   * - Triple-backtick form (`\`\`\`payload\`\`\``) is supported by
   *   the tokenizer; this function reads either form.
   */
  function parseTaggedString(taggedString: string): Atom {
    const backtickIndex = taggedString.indexOf("`");
    if (backtickIndex === -1) {
      throw new Error("Invalid tagged string, missing backtick");
    }
    const tag = taggedString.substring(0, backtickIndex);
    const rest = taggedString.substring(backtickIndex);

    // Long form: `tag\`\`\`payload\`\`\``
    let payload: string;
    if (rest.startsWith("```") && rest.endsWith("```") && rest.length >= 6) {
      payload = rest.slice(3, -3);
    } else if (rest.startsWith("`") && rest.endsWith("`") && rest.length >= 2) {
      // Short form: `tag\`payload\``
      payload = rest.slice(1, -1);
    } else {
      throw new Error("Malformed tagged string: " + taggedString);
    }

    if (tag === "json") {
      // Let parse errors propagate as a runtime error.
      return JSON.parse(payload);
    }
    return [tag, payload];
  }

  export function tokenize(str: string): string[] {
    const tokenizer = new LispTokenizer(str);
    const tokenObjs = tokenizer.tokenize();
    const tokens: string[] = [];

    for (const token of tokenObjs) {
      if (token.type === TokenType.EOF) break;
      // Preserve quotes for STRING tokens so parser can identify them
      if (token.type === TokenType.STRING) {
        tokens.push('"' + String(token.value) + '"');
      } else if (token.type === TokenType.LEFT_BRACKET) {
        tokens.push("[");
      } else if (token.type === TokenType.RIGHT_BRACKET) {
        tokens.push("]");
      } else if (token.type === TokenType.LEFT_BRACE) {
        tokens.push("{");
      } else if (token.type === TokenType.RIGHT_BRACE) {
        tokens.push("}");
      } else {
        tokens.push(String(token.value));
      }
    }

    return tokens;
  }

  function analyzeExpression(tokenList: Lisp.Expression[]): Lisp.Expression {
    if (tokenList.length === 0) return tokenList;

    const [operator, ...args] = tokenList;

    // Not a string operator, no optimization possible
    if (typeof operator !== "string") return tokenList;

    // Not an arithmetic operator, no optimization possible
    if (!ARITHMETIC_OPS.has(operator)) return tokenList;

    let flags = OptFlags.ARITHMETIC_OP;

    // Check if all args are numbers
    if (!args.every((arg) => typeof arg === "number")) {
      // Some optimization might still be possible, but not full optimization
      return new Lisp.OptimizedExpression(tokenList, flags);
    }

    // All args are numbers - we can optimize!
    flags |=
      OptFlags.ALL_NUMBERS | OptFlags.NO_EVAL_NEEDED | OptFlags.CONSTANT_EXPR;

    if (args.length === 0) {
      flags |= OptFlags.EMPTY_ARGS;
    } else if (args.length === 2) {
      flags |= OptFlags.SIMPLE_BINARY;
    }

    return new Lisp.OptimizedExpression(tokenList, flags);
  }

  export function readFromToken(
    tokens: string[],
    depth: number = 0,
  ): Lisp.Expression {
    if (tokens.length === 0) {
      throw new Error("unexpected no more tokens to parse");
    }
    const t = tokens.pop()!;
    if (t === "(") {
      const tokenList: Lisp.Expression[] = [];
      while (tokens.length > 0 && tokens[tokens.length - 1] !== ")") {
        const r: Lisp.Expression = Lisp.readFromToken(tokens, depth + 1);
        tokenList.push(r);
      }
      if (tokens.length === 0) {
        throw new Error("unexpected end of input, missing closing parenthesis");
      }
      tokens.pop(); // pops off the ")"

      // Check for bracket notation pattern: specifically "rows" followed by vector containing single string
      if (
        tokenList.length === 2 &&
        tokenList[0] === "rows" &&
        Array.isArray(tokenList[1]) &&
        tokenList[1][0] === "vector" &&
        tokenList[1].length === 2
      ) {
        // Extract the string value, handling quotes
        let stringValue = tokenList[1][1];
        if (stringValue instanceof Lisp.StringLiteral) {
          stringValue = stringValue.value;
        } else if (typeof stringValue === "string") {
          // Remove quotes if present
          if (stringValue.startsWith('"') && stringValue.endsWith('"')) {
            stringValue = stringValue.slice(1, -1);
          }
        }

        // Only reconstruct if we have a valid string value
        if (typeof stringValue === "string") {
          const bracketNotation = `rows["${stringValue}"]`;
          return bracketNotation;
        }
      }

      return analyzeExpression(tokenList);
    } else if (t === ")") {
      throw new Error("unexpected ')'");
    } else if (t === "[") {
      // Handle vector literal - transform [a b c] to (vector a b c)
      const elements: Lisp.Expression[] = [];
      while (tokens.length > 0 && tokens[tokens.length - 1] !== "]") {
        const r: Lisp.Expression = Lisp.readFromToken(tokens, depth + 1);
        elements.push(r);
      }
      if (tokens.length === 0) {
        throw new Error("unexpected end of input, missing closing bracket");
      }
      tokens.pop(); // pops off the "]"
      // Return as a vector call
      return ["vector", ...elements];
    } else if (t === "]") {
      throw new Error("unexpected ']'");
    } else if (t === "{") {
      // Handle map literal - transform {k1 v1 k2 v2} to (hash-map k1 v1 k2 v2)
      const kvPairs: Lisp.Expression[] = [];
      while (tokens.length > 0 && tokens[tokens.length - 1] !== "}") {
        const r: Lisp.Expression = Lisp.readFromToken(tokens, depth + 1);
        kvPairs.push(r);
      }
      if (tokens.length === 0) {
        throw new Error("unexpected end of input, missing closing brace");
      }
      tokens.pop(); // pops off the "}"
      // Check for even number of elements (key-value pairs)
      if (kvPairs.length % 2 !== 0) {
        throw new Error("map literal must have an even number of elements");
      }
      // Return as a hash-map call
      return ["hash-map", ...kvPairs];
    } else if (t === "}") {
      throw new Error("unexpected '}'");
    } else if (t === "'") {
      // Handle quote operator - transform 'expr to (quote expr)
      if (tokens.length === 0) {
        throw new Error("unexpected end of input after quote");
      }
      const quotedExpr = Lisp.readFromToken(tokens, depth + 1);
      return ["quote", quotedExpr];
    } else {
      // Check if it's a quoted string (starts and ends with double quotes)
      if (t.startsWith('"') && t.endsWith('"')) {
        // Wrap in StringLiteral to preserve it's a string literal, not a symbol
        return new StringLiteral(t.slice(1, -1));
      }
      // Check if it's a tagged string literal
      if (t.includes("`") && /\w+`/.test(t)) {
        return t; // Keep tagged strings as-is for evaluation
      }
      // Check for boolean literals
      if (t === "true") return true;
      if (t === "false") return false;
      // Check for null literal
      if (t === "null") return null as any;
      const maybeNum = Number.parseFloat(t);
      return Number.isNaN(maybeNum) ? t : maybeNum;
    }
  }

  // Simple LRU cache for parsed expressions
  class ParseLRUCache {
    private cache = new Map<string, Lisp.Expression>();
    private readonly maxSize = 128; // Small cache for frequently parsed expressions

    get(key: string): Lisp.Expression | undefined {
      const value = this.cache.get(key);
      if (value != null) {
        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, value);
      }
      return value;
    }

    set(key: string, value: Lisp.Expression): void {
      // Remove oldest entry if at capacity
      if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey != null) {
          this.cache.delete(firstKey);
        }
      }
      // Delete and re-add to move to end
      this.cache.delete(key);
      this.cache.set(key, value);
    }
  }

  const parseCache = new ParseLRUCache();

  export function parse(
    program: string,
    defaultProgram: Lisp.Expression = ["`invalid"],
  ): Lisp.Expression {
    try {
      return Lisp.unsafeParse(nonnull(program));
    } catch (_e) {
      return defaultProgram;
    }
  }

  export function unsafeParse(program: string): Lisp.Expression {
    // Check cache first
    const cached = parseCache.get(program);
    if (cached != null) {
      return cached;
    }

    // Check for top-level bracket notation like rows["key"]
    const bracketResult =
      BracketNotationUtils.parseTopLevelBracketNotation(program);
    if (bracketResult) {
      parseCache.set(program, bracketResult);
      return bracketResult;
    }

    // Parse and cache the result
    const tokens = Lisp.tokenize(program);
    const result = Lisp.readFromToken(tokens.reverse());
    parseCache.set(program, result);
    return result;
  }

  export function parseAll(program: string): Lisp.Expression {
    const tokens = Lisp.tokenize(program);
    if (tokens.length === 0) {
      return 0;
    }

    const reversed = tokens.reverse();
    const expressions: Lisp.Expression[] = [];

    while (reversed.length > 0) {
      expressions.push(Lisp.readFromToken(reversed));
    }

    if (expressions.length === 0) {
      return 0;
    }
    if (expressions.length === 1) {
      return expressions[0];
    }
    return ["begin", ...expressions];
  }

  export function evalThrows(
    expression: Lisp.Expression,
    env: Lisp.Environment,
  ): Option<Lisp.Expression> {
    env.evalCount.n += 1;
    if (env.evalCount.n === 10000) {
      throw Error(
        `Max eval count reached, last expression: ${String(expression)}`,
      );
    }

    // Handle StringLiteral wrapper
    if (expression instanceof StringLiteral) {
      return expression.value;
    }

    // Fast path for primitives
    if (typeof expression === "number" || typeof expression === "boolean")
      return expression;

    if (typeof expression === "string") {
      // Fast path for common keywords and literals
      const firstChar = expression[0];

      // Keywords (symbols starting with ':') evaluate to themselves
      if (firstChar === ":") {
        return expression;
      }

      // Fast path for quoted strings (only double quotes, not single quotes)
      if (firstChar === '"') {
        const len = expression.length;
        if (len >= 2 && expression[len - 1] === firstChar) {
          // Process escape sequences in string literals
          let str = expression.slice(1, -1);
          // Single regex replace with callback for all escape sequences
          str = str.replace(/\\(.)/g, (_, c) => {
            switch (c) {
              case "n":
                return "\n";
              case "t":
                return "\t";
              case "r":
                return "\r";
              case "\\":
                return "\\";
              case '"':
                return '"';
              case "'":
                return "'";
              default:
                return c;
            }
          });
          return str;
        }
      }

      // Check for boolean/null literals
      switch (expression) {
        case "true":
          return true;
        case "false":
          return false;
        case "null":
          return null as any;
      }

      // Handle tagged string literals (less common)
      if (expression.includes("`") && /\w+`/.test(expression)) {
        return parseTaggedString(expression);
      }

      // Default: symbol lookup in environment
      return env.get(expression);
    }

    if (typeof expression === "function") return expression;

    // Check for optimized expression with flags
    if (expression instanceof Lisp.OptimizedExpression) {
      const flags = expression.flags;
      const [operator, ...args] = expression.expr;

      // Ultra-fast path when all args are numbers
      if (flags & OptFlags.ALL_NUMBERS) {
        const nums = args as number[];

        // Handle empty args case
        if (flags & OptFlags.EMPTY_ARGS) {
          switch (operator) {
            case "+":
              return 0;
            case "-":
              return 0;
            case "*":
              return 1;
            case "**":
              return 1;
            default:
              throw new Error(`${operator} requires at least one argument`);
          }
        }

        // Handle simple binary operations
        if (flags & OptFlags.SIMPLE_BINARY) {
          switch (operator) {
            case "+":
              return nums[0] + nums[1];
            case "-":
              return nums[0] - nums[1];
            case "*":
              return nums[0] * nums[1];
            case "/":
              return nums[0] / nums[1];
            case "%":
              return nums[0] % nums[1];
            case "**":
              return nums[0] ** nums[1];
            case "//":
              return Math.floor(nums[0] / nums[1]);
          }
        }

        // Handle general case
        switch (operator) {
          case "+": {
            if (nums.length === 1) return nums[0];
            let sum = 0;
            for (let i = 0; i < nums.length; i++) sum += nums[i];
            return sum;
          }
          case "-": {
            if (nums.length === 1) return -nums[0];
            let result = nums[0];
            for (let i = 1; i < nums.length; i++) result -= nums[i];
            return result;
          }
          case "*": {
            if (nums.length === 1) return nums[0];
            let product = 1;
            for (let i = 0; i < nums.length; i++) product *= nums[i];
            return product;
          }
          case "/": {
            if (nums.length === 1) return 1 / nums[0];
            let result = nums[0];
            for (let i = 1; i < nums.length; i++) result /= nums[i];
            return result;
          }
          case "%": {
            if (nums.length !== 2)
              throw new Error("Modulo requires exactly 2 arguments");
            return nums[0] % nums[1];
          }
          case "**": {
            if (nums.length === 1) return nums[0];
            let result = nums[0];
            for (let i = 1; i < nums.length; i++) result = result ** nums[i];
            return result;
          }
          case "//": {
            if (nums.length === 1) return Math.floor(1 / nums[0]);
            let result = nums[0];
            for (let i = 1; i < nums.length; i++) result /= nums[i];
            return Math.floor(result);
          }
        }
      }

      // Check if it's an arithmetic op but args need evaluation
      if (flags & OptFlags.ARITHMETIC_OP) {
        const stdFn = StandardLibrary.get(operator as string);
        if (stdFn && typeof stdFn === "function") {
          return stdFn(args as Lisp.Atom[], env);
        }
      }

      // Fall through to regular array handling for non-optimized cases
      expression = expression.expr;
    }

    if (Array.isArray(expression)) {
      const [operator, ...args] = expression;

      // Check control flow operations first (they can't be overridden)
      const controlFlowFn = ControlFlow.get(operator);
      if (controlFlowFn) return controlFlowFn(args, env);

      // Check environment for user-defined functions and built-ins
      if (typeof operator === "string") {
        const envFn = env.get(operator);

        // env.get() returns the key itself if not found, so check if it's actually a function
        if (typeof envFn === "function") {
          // Determine if this is a built-in or user-defined function
          // Built-ins handle their own argument evaluation, user functions need pre-evaluated args
          const isActualBuiltin =
            StandardLibrary.has(operator) &&
            StandardLibrary.get(operator) === envFn;

          if (isActualBuiltin) {
            // Built-in function - pass unevaluated arguments
            return envFn(args as Lisp.Atom[], env);
          }

          // User-defined function - evaluate arguments first
          const evaluatedArgs = args.map((arg: Lisp.Atom) => {
            if (arg instanceof StringLiteral) {
              return arg.value;
            }
            return Lisp.evalThrows(arg, env);
          });
          return envFn(evaluatedArgs as Lisp.Atom[], env);
        }
      }

      // Regular evaluation path - evaluate synchronously
      const evaluated = expression.map((e: Lisp.Atom) => {
        if (e instanceof StringLiteral) {
          return e.value;
        }
        return Lisp.evalThrows(e, env);
      });
      const [proc, ...procArgs] = evaluated;

      if (typeof proc === "number") return proc;
      if (typeof proc === "function") {
        return (proc as Lisp.Procedure)(procArgs as Lisp.Atom[], env);
      }
      if (typeof proc === "boolean") return proc;

      // If we couldn't evaluate to a function, return the evaluated expression
      return [proc, ...procArgs];
    }
    return expression;
  }

  export function run(
    expression: Lisp.Expression,
    environment: Lisp.Environment = new Lisp.Environment.Default(),
  ): Option<Lisp.Expression> {
    try {
      return Lisp.evalThrows(expression, environment);
    } catch (e) {
      if (e instanceof CacheMissError) return null;
      return String(e);
    }
  }

  // export const resolve = async (args: Atom[], env: Environment) => {
  //   // return Promise.all(args.map(async (e) => await evalThrows(e, env)));
  //   let r: Option<Expression>[] = [];
  //   for (const arg of args) {
  //     r.push(await evalThrows(arg, env));
  //   }
  //   return r;
  // };

  export const resolve = (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Evaluate all arguments synchronously
    return args.map((arg) => {
      // StringLiterals should return their value directly
      // without further evaluation
      if (arg instanceof Lisp.StringLiteral) {
        return arg.value;
      }
      return Lisp.evalThrows(arg, env);
    });
  };

  export namespace Utils {
    export function visitExpression(
      ast: Lisp.Expression,
      fn: (ast: Lisp.Expression) => void,
    ) {
      if (!Array.isArray(ast)) {
        fn(ast);
        return;
      }
      for (const subexp of ast) {
        Utils.visitExpression(subexp, fn);
      }
    }

    export function toStr(n: Option<Lisp.Atom>): Option<string> {
      return typeof n === "string" ? n : null;
    }

    export function toStrs(arr: Option<Lisp.Atom>[]): Option<string>[] {
      return arr.map((a) => toStr(a));
    }

    export function assertNum(n: Option<Lisp.Atom>, context: string): number {
      if (typeof n !== "number" || Number.isNaN(n)) {
        throw new Error(
          `expected number, got: '${String(n)}' (type: ${typeof n}). Context (${context})`,
        );
      }
      return n;
    }

    export function assertNums(
      arr: Option<Lisp.Atom>[],
      context: string,
    ): number[] {
      return arr.map((a) => assertNum(a, context));
    }

    // Lisp truthiness: only false and null/undefined are falsy
    // Everything else is truthy (including 0, "", empty arrays, etc.)
    export const isTruthy = (value: any): boolean => {
      return value !== false && value !== null && value !== undefined;
    };
  }

  export interface Environment {
    evalCount: EvalCount;
    clone(keys: string[], values: Lisp.Expression[]): Environment;
    set(key: string, value: Lisp.Expression): void;
    get(key: string): Option<Lisp.Expression>;
  }

  export namespace Environment {
    /**
     * Lazy environment that only creates a new Map when values are actually modified.
     * This avoids unnecessary cloning for read-only function calls.
     */
    export class Lazy implements Environment {
      private modified: Map<string, Lisp.Expression> | null = null;

      constructor(
        private parent: Environment | null,
        private baseScope: Map<string, Lisp.Expression>,
        public readonly evalCount: EvalCount,
      ) {}

      clone(keys: string[], values: Lisp.Expression[]): Environment {
        // Always chain — empty `keys` is a `let`/scope-bracket call
        // that needs an isolated env to mutate via `set` without
        // leaking back to the parent (otherwise nested `(let ...)` with
        // shadowing variables corrupts the outer scope).
        const newBindings = new Map<string, Lisp.Expression>();
        for (let i = 0; i < keys.length; i++) {
          newBindings.set(keys[i], values[i]);
        }
        return new Lazy(this, newBindings, this.evalCount);
      }

      set(key: string, value: Lisp.Expression): void {
        // Lazy initialization of modified map
        if (!this.modified) {
          this.modified = new Map();
        }
        this.modified.set(key, value);
      }

      get(key: string): Option<Lisp.Expression> {
        // Check modified values first
        if (this.modified?.has(key)) {
          return this.modified.get(key);
        }

        // Check base scope
        const baseValue = this.baseScope.get(key);
        if (baseValue !== undefined) {
          return baseValue;
        }

        // Check parent environment
        if (this.parent) {
          return this.parent.get(key);
        }

        // Finally check control-flow + standard library; if neither
        // resolves, fall through to the key itself as a string. (This
        // matches `SheetLispEnvironment` and lets unbound symbols
        // round-trip through `apply` / `hash-map` etc.)
        return ControlFlow.get(key) ?? StandardLibrary.get(key) ?? key;
      }
    }

    export class Default implements Environment {
      constructor(
        public readonly scope: Map<string, Lisp.Expression> = new Map(),
        public readonly evalCount: EvalCount = {
          n: 0,
        },
      ) {}

      clone(keys: string[], values: Lisp.Expression[]): Environment {
        // Switch to lazy environment for cloning
        return new Lazy(null, this.scope, this.evalCount).clone(keys, values);
      }

      set(key: string, value: Lisp.Expression): Default {
        this.scope.set(key, value);
        return this;
      }

      get(key: string): Option<Lisp.Expression> {
        // Check local scope first (most common case)
        const local = this.scope.get(key);
        if (local !== undefined) return local;
        // Then control-flow + standard library; finally fall through
        // to the key itself as a string (matches `SheetLispEnvironment`).
        return ControlFlow.get(key) ?? StandardLibrary.get(key) ?? key;
      }
    }
  }
}

export function flattenLib<Fn>(
  obj: Record<string, any>,
  prefix = "",
  map = new Map<string, any>(),
): Map<string, Fn> {
  for (const key in obj) {
    const newKey = key === "_" ? prefix : prefix ? `${prefix}.${key}` : key;
    if (
      typeof obj[key] === "object" &&
      obj[key] != null &&
      !Array.isArray(obj[key])
    ) {
      flattenLib(obj[key], newKey, map);
    } else {
      map.set(newKey, obj[key]);
    }
  }
  return map;
}
