import { Lisp } from "../lisp";

/** A value's kind in `OptimizedStdLib.compareDefault`'s order. */
function sortRank(v: Lisp.Atom): number {
  if (typeof v === "number") return 0;
  if (typeof v === "string") return 1;
  if (typeof v === "boolean") return 2;
  if (v === null) return 3;
  if (Array.isArray(v)) return 4;
  return 5;
}

/**
 * Optimized Standard Library implementations for hot-path functions.
 * These implementations avoid unnecessary Promise overhead and provide
 * specialized fast paths for common usage patterns.
 */
export class OptimizedStdLib {
  /**
   * Optimized length function for strings and arrays
   */
  static len(arg: Lisp.Atom): number {
    if (typeof arg === "string") {
      return arg.length;
    }
    if (Array.isArray(arg)) {
      return arg.length;
    }
    if (typeof arg === "number") {
      return String(arg).length;
    }
    return 0;
  }

  /**
   * Optimized list creation
   */
  static list(...args: Lisp.Atom[]): Lisp.Atom[] {
    return args;
  }

  /**
   * Optimized first element accessor
   */
  static first(list: Lisp.Atom[]): Lisp.Atom {
    if (!Array.isArray(list)) {
      throw new Error("first expects a list");
    }
    return list[0];
  }

  /**
   * Optimized rest (tail) accessor
   */
  static rest(list: Lisp.Atom[]): Lisp.Atom[] {
    if (!Array.isArray(list)) {
      throw new Error("rest expects a list");
    }
    return list.slice(1);
  }

  /**
   * Optimized reverse function
   */
  static reverse(list: Lisp.Atom[]): Lisp.Atom[] {
    if (!Array.isArray(list)) {
      throw new Error("reverse expects a list");
    }
    // Use a more efficient reverse for small arrays
    if (list.length <= 10) {
      const result = new Array(list.length);
      for (let i = 0; i < list.length; i++) {
        result[list.length - 1 - i] = list[i];
      }
      return result;
    }
    return list.slice().reverse();
  }

  /**
   * Optimized range function
   */
  static range(start: number, end?: number, step?: number): number[] {
    // Handle single argument (end only)
    if (end === undefined) {
      end = start;
      start = 0;
    }
    
    step = step || 1;
    
    if (step === 0) {
      throw new Error("range step cannot be zero");
    }
    
    const length = Math.max(0, Math.ceil((end - start) / step));
    const result = new Array(length);
    
    for (let i = 0; i < length; i++) {
      result[i] = start + i * step;
    }
    
    return result;
  }

  /**
   * Optimized append for lists
   */
  static append(...lists: Lisp.Atom[][]): Lisp.Atom[] {
    // Fast path for two lists
    if (lists.length === 2) {
      return lists[0].concat(lists[1]);
    }
    
    // Calculate total length for pre-allocation
    let totalLength = 0;
    for (const list of lists) {
      if (Array.isArray(list)) {
        totalLength += list.length;
      }
    }
    
    const result = new Array(totalLength);
    let index = 0;
    
    for (const list of lists) {
      if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
          result[index++] = list[i];
        }
      }
    }
    
    return result;
  }

  /**
   * Optimized string concatenation
   */
  static concat(...args: Lisp.Atom[]): string {
    // Use array join for better performance with many strings
    if (args.length > 10) {
      const parts = new Array(args.length);
      for (let i = 0; i < args.length; i++) {
        parts[i] = String(args[i]);
      }
      return parts.join("");
    }
    
    // Direct concatenation for small number of strings
    let result = "";
    for (let i = 0; i < args.length; i++) {
      result += String(args[i]);
    }
    return result;
  }

  /**
   * Optimized min function
   */
  static min(...args: number[]): number {
    if (args.length === 0) {
      return Infinity;
    }
    if (args.length === 1) {
      return args[0];
    }
    if (args.length === 2) {
      return args[0] < args[1] ? args[0] : args[1];
    }
    
    let min = args[0];
    for (let i = 1; i < args.length; i++) {
      if (args[i] < min) {
        min = args[i];
      }
    }
    return min;
  }

  /**
   * Optimized max function
   */
  static max(...args: number[]): number {
    if (args.length === 0) {
      return -Infinity;
    }
    if (args.length === 1) {
      return args[0];
    }
    if (args.length === 2) {
      return args[0] > args[1] ? args[0] : args[1];
    }
    
    let max = args[0];
    for (let i = 1; i < args.length; i++) {
      if (args[i] > max) {
        max = args[i];
      }
    }
    return max;
  }

  /**
   * Optimized abs function
   */
  static abs(n: number): number {
    return n < 0 ? -n : n;
  }

  /**
   * Optimized floor function
   */
  static floor(n: number): number {
    return Math.floor(n);
  }

  /**
   * Optimized ceil function
   */
  static ceil(n: number): number {
    return Math.ceil(n);
  }

  /**
   * Optimized round function
   */
  static round(n: number): number {
    return Math.round(n);
  }

  /**
   * Optimized sqrt function
   */
  static sqrt(n: number): number {
    return Math.sqrt(n);
  }

  /**
   * Optimized not function
   */
  static not(value: Lisp.Atom): boolean {
    return !Lisp.Utils.isTruthy(value);
  }

  /**
   * Optimized boolean conversion
   */
  static bool(value: Lisp.Atom): boolean {
    return Lisp.Utils.isTruthy(value);
  }

  /**
   * Optimized take function - returns first n elements
   */
  static take(n: number, list: Lisp.Atom[]): Lisp.Atom[] {
    if (!Array.isArray(list)) {
      throw new Error("take expects a list");
    }
    if (n <= 0) {
      return [];
    }
    if (n >= list.length) {
      return list;
    }
    return list.slice(0, n);
  }

  /**
   * Optimized drop function - returns all but first n elements
   */
  static drop(n: number, list: Lisp.Atom[]): Lisp.Atom[] {
    if (!Array.isArray(list)) {
      throw new Error("drop expects a list");
    }
    if (n <= 0) {
      return list;
    }
    if (n >= list.length) {
      return [];
    }
    return list.slice(n);
  }

  /**
   * Optimized flatten function
   */
  static flatten(list: Lisp.Atom[], depth: number = 1): Lisp.Atom[] {
    if (!Array.isArray(list)) {
      return [list];
    }
    
    if (depth <= 0) {
      return list;
    }
    
    const result: Lisp.Atom[] = [];
    for (const item of list) {
      if (Array.isArray(item) && depth > 0) {
        const flattened = this.flatten(item, depth - 1);
        for (const subItem of flattened) {
          result.push(subItem);
        }
      } else {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Optimized unique function - removes duplicates
   */
  static unique(list: Lisp.Atom[]): Lisp.Atom[] {
    if (!Array.isArray(list)) {
      throw new Error("unique expects a list");
    }
    
    // For small lists, use simple approach
    if (list.length <= 10) {
      const result: Lisp.Atom[] = [];
      const seen = new Set<Lisp.Atom>();
      for (const item of list) {
        const key = typeof item === "object" ? JSON.stringify(item) : item;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(item);
        }
      }
      return result;
    }
    
    // For larger lists, use Set
    return [...new Set(list)];
  }

  /**
   * Sort a copy of `list`: by `compareFn` when given (any order it defines,
   * as `Array.prototype.sort` takes it), else by `compareDefault`.
   */
  static sort(list: Lisp.Atom[], compareFn?: (a: Lisp.Atom, b: Lisp.Atom) => number): Lisp.Atom[] {
    if (!Array.isArray(list)) {
      throw new Error("sort expects a list");
    }

    // Clone array to avoid mutation
    const result = list.slice();
    result.sort(compareFn ?? OptimizedStdLib.compareDefault);
    return result;
  }

  /**
   * The default order of `sort`, a total order (operator decision
   * 2026-11-01, formula-engine-port.md FE-10): numbers ascending with `NaN`
   * last among them, then strings by `localeCompare`, then `false`, `true`,
   * then `null`, then lists, then every other value, lists and other values
   * by `String(x).localeCompare`. `undefined` sorts last without being
   * compared, as `Array.prototype.sort` does.
   *
   * The comparator it replaces answered `a - b` for two numbers and
   * `String(a).localeCompare(String(b))` otherwise, which is no order once a
   * list mixes kinds or holds `NaN`; V8 then placed elements by the
   * comparisons its sort happened to make, which change when a hot sort is
   * inlined, so one formula sorted two ways in one process. Lists of numbers
   * without `NaN`, and lists of strings, sort as they did.
   */
  static compareDefault(a: Lisp.Atom, b: Lisp.Atom): number {
    const ra = sortRank(a);
    const rb = sortRank(b);
    if (ra !== rb) return ra - rb;
    if (typeof a === "number" && typeof b === "number") {
      const nanA = Number.isNaN(a);
      const nanB = Number.isNaN(b);
      if (nanA || nanB) return nanA === nanB ? 0 : nanA ? 1 : -1;
      return a - b;
    }
    if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
    if (a === null && b === null) return 0;
    return String(a).localeCompare(String(b));
  }


  /**
   * Optimized includes/contains function
   */
  static includes(list: Lisp.Atom[], item: Lisp.Atom): boolean {
    if (!Array.isArray(list)) {
      return false;
    }
    
    // Use indexOf for primitives (faster than includes)
    if (typeof item !== "object") {
      return list.indexOf(item) !== -1;
    }
    
    // For objects, use deep comparison
    const itemStr = JSON.stringify(item);
    for (const element of list) {
      if (typeof element === "object" && JSON.stringify(element) === itemStr) {
        return true;
      }
    }
    return false;
  }

  /**
   * Optimized count function
   */
  static count(list: Lisp.Atom[], predicate?: (item: Lisp.Atom) => boolean): number {
    if (!Array.isArray(list)) {
      return 0;
    }
    
    if (!predicate) {
      return list.length;
    }
    
    let count = 0;
    for (const item of list) {
      if (predicate(item)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Optimized every function
   */
  static every(list: Lisp.Atom[], predicate: (item: Lisp.Atom) => boolean): boolean {
    if (!Array.isArray(list)) {
      return true;
    }
    
    for (const item of list) {
      if (!predicate(item)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Optimized some function
   */
  static some(list: Lisp.Atom[], predicate: (item: Lisp.Atom) => boolean): boolean {
    if (!Array.isArray(list)) {
      return false;
    }
    
    for (const item of list) {
      if (predicate(item)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Optimized zip function
   */
  static zip(...lists: Lisp.Atom[][]): Lisp.Atom[][] {
    if (lists.length === 0) {
      return [];
    }
    
    const minLength = Math.min(...lists.map(l => Array.isArray(l) ? l.length : 0));
    const result = new Array(minLength);
    
    for (let i = 0; i < minLength; i++) {
      const tuple = new Array(lists.length);
      for (let j = 0; j < lists.length; j++) {
        tuple[j] = lists[j][i];
      }
      result[i] = tuple;
    }
    
    return result;
  }
}