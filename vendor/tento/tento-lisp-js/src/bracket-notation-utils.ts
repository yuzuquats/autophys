/**
 * Shared utilities for parsing bracket notation like rows["key"] and common string operations
 * Used by both old and new Lisp implementations
 */

export namespace BracketNotationUtils {
  const BRACKET_PATTERN = /^(\w+)\["([^"]+)"\]$/;

  /**
   * Parses top-level bracket notation and returns the bracket notation string
   * if it matches the expected pattern, otherwise returns null
   */
  export function parseTopLevelBracketNotation(program: string): string | null {
    const bracketMatch = program.match(BRACKET_PATTERN);
    if (bracketMatch) {
      const [, identifier, key] = bracketMatch;
      if (identifier === "rows") {
        return `rows["${key}"]`;
      }
    }
    return null;
  }

  /**
   * Checks if a string represents bracket notation
   */
  export function isBracketNotation(str: string): boolean {
    return BRACKET_PATTERN.test(str);
  }

  /**
   * Extracts the identifier and key from bracket notation
   * Returns null if not valid bracket notation
   */
  export function parseBracketNotation(str: string): { identifier: string; key: string } | null {
    const match = str.match(BRACKET_PATTERN);
    if (match) {
      const [, identifier, key] = match;
      return { identifier, key };
    }
    return null;
  }

  /**
   * Concatenates arguments into a string, handling null/undefined values
   * Shared implementation for str function
   */
  export function concatenateToString(args: any[]): string {
    return args.map((arg) => {
      if (arg == null || arg === undefined) return "";
      return String(arg);
    }).join("");
  }
}