import { Lisp } from "../lisp";

/**
 * Batch operations for vectorized processing of list operations.
 * These functions optimize operations on arrays by reducing Promise overhead
 * and processing multiple values at once when possible.
 */

export class BatchOperations {
  /**
   * Check if a function can be evaluated synchronously for all inputs
   */
  private static canBatchSynchronously(
    fn: Lisp.Expression,
    list: Lisp.Atom[],
    env: Lisp.Environment
  ): boolean {
    // If fn is a lambda with simple arithmetic operations, we can batch
    if (Array.isArray(fn) && fn[0] === "lambda") {
      const [, params, body] = fn as [string, string[], Lisp.Expression];
      
      // Check if body is a simple arithmetic expression
      if (Array.isArray(body)) {
        const [op] = body;
        // These operations can be batched if all args are numbers
        if (typeof op === "string" && ["+", "-", "*", "/", "%", "**", "//"].includes(op)) {
          // Check if all list items are numbers
          return list.every(item => typeof item === "number");
        }
      }
    }
    
    return false;
  }

  /**
   * Create a fast path evaluator for simple lambda functions
   */
  private static createFastEvaluator(
    fn: Lisp.Expression
  ): ((x: number) => number) | null {
    if (!Array.isArray(fn) || fn[0] !== "lambda") {
      return null;
    }

    const [, params, body] = fn as [string, string[], Lisp.Expression];
    
    // Only support single parameter lambdas for now
    if (!Array.isArray(params) || params.length !== 1) {
      return null;
    }

    const param = params[0];

    // Handle simple arithmetic bodies
    if (Array.isArray(body)) {
      const [op, ...operands] = body;
      
      if (typeof op === "string") {
        // Create optimized evaluator based on operation
        switch (op) {
          case "+": {
            // (lambda (x) (+ x n)) or (lambda (x) (+ n x))
            if (operands.length === 2) {
              const idx = operands.indexOf(param);
              if (idx !== -1) {
                const constant = operands[1 - idx];
                if (typeof constant === "number") {
                  return (x: number) => x + constant;
                }
              }
            }
            break;
          }
          case "-": {
            // (lambda (x) (- x n)) or (lambda (x) (- n x))
            if (operands.length === 2) {
              if (operands[0] === param && typeof operands[1] === "number") {
                const n = operands[1];
                return (x: number) => x - n;
              } else if (operands[1] === param && typeof operands[0] === "number") {
                const n = operands[0];
                return (x: number) => n - x;
              }
            }
            break;
          }
          case "*": {
            // (lambda (x) (* x x)) - squaring
            if (operands.length === 2 && operands[0] === param && operands[1] === param) {
              return (x: number) => x * x;
            }
            // (lambda (x) (* x n)) or (lambda (x) (* n x))
            if (operands.length === 2) {
              const idx = operands.indexOf(param);
              if (idx !== -1) {
                const constant = operands[1 - idx];
                if (typeof constant === "number") {
                  return (x: number) => x * constant;
                }
              }
            }
            break;
          }
          case "/": {
            // (lambda (x) (/ x n)) or (lambda (x) (/ n x))
            if (operands.length === 2) {
              if (operands[0] === param && typeof operands[1] === "number") {
                const n = operands[1];
                return (x: number) => x / n;
              } else if (operands[1] === param && typeof operands[0] === "number") {
                const n = operands[0];
                return (x: number) => n / x;
              }
            }
            break;
          }
          case "%": {
            // (lambda (x) (% x n))
            if (operands.length === 2) {
              if (operands[0] === param && typeof operands[1] === "number") {
                const n = operands[1];
                return (x: number) => x % n;
              }
            }
            break;
          }
          case "**": {
            // (lambda (x) (** x n))
            if (operands.length === 2) {
              if (operands[0] === param && typeof operands[1] === "number") {
                const n = operands[1];
                return (x: number) => x ** n;
              }
            }
            break;
          }
        }
      }
    } else if (body === param) {
      // Identity function: (lambda (x) x)
      return (x: number) => x;
    } else if (typeof body === "number") {
      // Constant function: (lambda (x) 5)
      return () => body;
    }

    return null;
  }

  /**
   * Optimized map implementation with batch processing
   */
  static optimizedMap(
    args: Lisp.Atom[],
    env: Lisp.Environment
  ): Lisp.Atom {
    const [fn, list] = args;
    const resolvedList = Lisp.evalThrows(list, env);
    if (resolvedList == null) {
      throw new Error("map: list evaluation failed");
    }

    // If not an array, treat as single value
    if (!Array.isArray(resolvedList)) {
      const result = Lisp.evalThrows([fn, ["quote", resolvedList]], env);
      if (result == null) {
        throw new Error("map: function evaluation failed");
      }
      return result;
    }

    // Try to create a fast evaluator for simple numeric operations
    const fastEval = this.createFastEvaluator(fn);
    if (fastEval && resolvedList.every(item => typeof item === "number")) {
      // Ultra-fast path: process all numbers synchronously
      const numbers = resolvedList as number[];
      const result = new Array(numbers.length);
      for (let i = 0; i < numbers.length; i++) {
        result[i] = fastEval(numbers[i]);
      }
      return result;
    }

    // Check if we can batch synchronously
    if (this.canBatchSynchronously(fn, resolvedList, env)) {
      // Fast synchronous path for simple operations
      const result: Lisp.Atom[] = [];
      for (const item of resolvedList) {
        // Since we know these are simple operations on numbers,
        // we can evaluate without Promise overhead
        const evalResult = Lisp.evalThrows([fn, ["quote", item]], env);
        result.push(evalResult as Lisp.Atom);
      }
      return result;
    }

    // Standard path: evaluate each element synchronously. `Lisp.evalThrows`
    // is synchronous (returns `Option<Lisp.Expression>`, not a Promise), so
    // the result must be a plain list — wrapping it in `Promise.all` returned
    // a Promise that downstream list ops (`nth`/`length`/`first`) reject and
    // `JSON.stringify` renders as `{}`. One sync loop for all sizes.
    const result: Lisp.Atom[] = [];
    for (const item of resolvedList) {
      const evalResult = Lisp.evalThrows([fn, ["quote", item]], env);
      result.push(evalResult as Lisp.Atom);
    }
    return result;
  }

  /**
   * Optimized filter implementation with batch processing
   */
  static optimizedFilter(
    args: Lisp.Atom[],
    env: Lisp.Environment
  ): Lisp.Atom {
    const [fn, list] = args;
    const resolvedList = Lisp.evalThrows(list, env);
    
    if (!Array.isArray(resolvedList)) {
      throw new Error("Second argument to filter must be a list");
    }

    // Try to create a fast evaluator for simple predicates
    const fastEval = this.createFastEvaluator(fn);
    if (fastEval && resolvedList.every(item => typeof item === "number")) {
      // Ultra-fast path: process all numbers synchronously
      const numbers = resolvedList as number[];
      const result: number[] = [];
      for (let i = 0; i < numbers.length; i++) {
        const value = fastEval(numbers[i]);
        if (Lisp.Utils.isTruthy(value)) {
          result.push(numbers[i]);
        }
      }
      return result;
    }

    // Standard path
    const result: Lisp.Atom[] = [];
    for (const item of resolvedList) {
      const test = Lisp.evalThrows([fn, ["quote", item]], env);
      if (Lisp.Utils.isTruthy(test)) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Optimized reduce implementation with batch processing
   */
  static optimizedReduce(
    args: Lisp.Atom[],
    env: Lisp.Environment
  ): Lisp.Atom {
    const [fn, initial, list] = args;  // fold/reduce expects: fn, initial, list
    const resolvedList = Lisp.evalThrows(list, env);
    
    if (!Array.isArray(resolvedList)) {
      throw new Error("Third argument to reduce must be a list");
    }

    let acc = initial !== undefined ? Lisp.evalThrows(initial, env) : resolvedList[0];
    const startIdx = initial !== undefined ? 0 : 1;

    // Check if we can use a fast path for numeric reduction
    if (
      typeof acc === "number" &&
      resolvedList.every(item => typeof item === "number") &&
      Array.isArray(fn) && fn[0] === "lambda"
    ) {
      const [, params, body] = fn as [string, string[], Lisp.Expression];
      
      // Check for common reduction patterns
      if (Array.isArray(body) && params.length === 2) {
        const [op] = body;
        if (typeof op === "string") {
          const numbers = resolvedList as number[];
          
          switch (op) {
            case "+":
              // Fast sum reduction
              for (let i = startIdx; i < numbers.length; i++) {
                acc = (acc as number) + numbers[i];
              }
              return acc;
            case "*":
              // Fast product reduction
              for (let i = startIdx; i < numbers.length; i++) {
                acc = (acc as number) * numbers[i];
              }
              return acc;
            case "-":
              // Fast subtraction reduction
              for (let i = startIdx; i < numbers.length; i++) {
                acc = (acc as number) - numbers[i];
              }
              return acc;
          }
        }
      }
    }

    // Standard path
    for (let i = startIdx; i < resolvedList.length; i++) {
      acc = Lisp.evalThrows([fn, ["quote", acc], ["quote", resolvedList[i]]], env);
    }
    return acc;
  }

  /**
   * Process array operations using typed arrays for better performance
   */
  static processNumericArray(
    array: number[],
    operation: (x: number) => number
  ): number[] {
    // For large arrays, use typed arrays for better memory locality
    if (array.length > 1000) {
      const typed = new Float64Array(array);
      const result = new Float64Array(typed.length);
      for (let i = 0; i < typed.length; i++) {
        result[i] = operation(typed[i]);
      }
      return Array.from(result);
    }

    // For smaller arrays, use regular array processing
    const result = new Array(array.length);
    for (let i = 0; i < array.length; i++) {
      result[i] = operation(array[i]);
    }
    return result;
  }
}