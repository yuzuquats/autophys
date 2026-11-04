import { Lisp, flattenLib } from "../lisp";

const define = ([symbol, ...rest]: Lisp.Atom[], env: Lisp.Environment) => {
  // Check if this is function definition shorthand: (define (name params...) body...)
  if (Array.isArray(symbol) && symbol.length >= 1) {
    const [functionName, ...params] = symbol;
    const funcName = typeof functionName === "string" ? functionName : String(functionName);

    // rest contains the body expressions
    const body = rest;

    // Create a lambda with the params and body (similar to defun)
    const lambda = (procArgs: Lisp.Atom[], procEnv: Lisp.Environment) => {
      const newEnv = procEnv.clone(params as string[], procArgs);

      let result: Option<Lisp.Expression> = null;
      for (const expr of body) {
        result = Lisp.evalThrows(expr, newEnv);
      }

      return result;
    };

    env.set(funcName, lambda);
    return 0;
  }

  // Original simple variable definition: (define name value)
  const symbolName = typeof symbol === "string" ? symbol : String(symbol);
  const exp = rest[0];
  const expressionResolved = Lisp.evalThrows(exp, env);
  if (expressionResolved != null) {
    env.set(symbolName, expressionResolved);
  }
  return 0; // Standard Lisp behavior: define returns undefined/0
};

export const ControlFlow = flattenLib<Lisp.Procedure>({
  quote: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Quote is a special form that returns its argument without evaluation
    if (args.length !== 1) {
      throw new Error("quote expects exactly one argument");
    }

    // Tagged-string symbols (e.g. `json\`{...}\``, `sql\`...\``)
    // arrive as raw string tokens from the parser. Under quote, they
    // return their structural form `[tag, payload]` — uniform with
    // `'(a b c)` returning `["a", "b", "c"]` (no parser execution).
    const taggedStringStructural = (s: string): [string, string] | null => {
      const idx = s.indexOf("`");
      if (idx <= 0) return null;
      const tag = s.substring(0, idx);
      const rest = s.substring(idx);
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tag)) return null;
      if (rest.startsWith("```") && rest.endsWith("```") && rest.length >= 6) {
        return [tag, rest.slice(3, -3)];
      }
      if (rest.startsWith("`") && rest.endsWith("`") && rest.length >= 2) {
        return [tag, rest.slice(1, -1)];
      }
      return null;
    };

    // Recursively unwrap StringLiteral and OptimizedExpression objects.
    const unwrapQuotedObjects = (expr: any): any => {
      if (expr instanceof Lisp.StringLiteral) {
        return expr.value;
      } else if (expr instanceof Lisp.OptimizedExpression) {
        return unwrapQuotedObjects(expr.expr);
      } else if (Array.isArray(expr)) {
        return expr.map(unwrapQuotedObjects);
      } else if (typeof expr === "string") {
        const tagged = taggedStringStructural(expr);
        if (tagged) return tagged;
        return expr;
      } else {
        return expr;
      }
    };

    return unwrapQuotedObjects(args[0]);
  },
  if: ([test, conseq, alt]: Lisp.Atom[], env: Lisp.Environment) => {
    const testResult = Lisp.evalThrows(test, env);
    if (Lisp.Utils.isTruthy(testResult)) {
      return Lisp.evalThrows(conseq, env);
    } else {
      if (alt == null) return 0;
      return Lisp.evalThrows(alt, env);
    }
  },
  match: ([val, ...cases]: Lisp.Atom[], env: Lisp.Environment) => {
    const v = Lisp.evalThrows(val, env);
    for (const caseExpr of cases as Lisp.Atom[][]) {
      if (!Array.isArray(caseExpr) || caseExpr.length < 2) {
        continue;
      }
      const [test, ...body] = caseExpr;

      // Check if the test matches
      let matches = false;
      if (Array.isArray(test)) {
        // If test is a list, check if v is in the list
        for (const testVal of test) {
          const evaluated = Lisp.evalThrows(testVal, env);
          if (evaluated === v) {
            matches = true;
            break;
          }
        }
      } else {
        // Single test value - check for wildcard first
        if (test === "_") {
          matches = true; // Wildcard matches anything
        } else {
          const testVal = Lisp.evalThrows(test, env);
          matches = testVal === v || testVal === true;
        }
      }

      if (matches) {
        // Evaluate and return the last expression in the body
        let result: Option<Lisp.Expression> = null;
        for (const expr of body) {
          result = Lisp.evalThrows(expr, env);
        }
        return result;
      }
    }
    return 0;
  },
  lambda: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const params = args[0];
    const exp = args[1];
    // Capture the environment at definition time for lexical scoping
    return (procArgs: Lisp.Atom[], _procEnv: Lisp.Environment) =>
      Lisp.evalThrows(exp, env.clone(params as string[], procArgs));
  },
  define,
  let: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // let supports multiple syntaxes:
    // 1. Simple syntax: (let var value body...)
    // 2. Common Lisp syntax: (let ((var1 value1) (var2 value2) ...) body...)
    // 3. Clojure syntax: (let [var1 value1 var2 value2 ...] body...)
    if (args.length < 2) {
      throw new Error("let expects at least 2 arguments");
    }

    // Check if first argument is a list of bindings (Common Lisp syntax)
    // or a simple variable name (simple syntax)
    const firstArg = args[0];
    let letEnv = env.clone([], []);
    let bodyStart = 1;
    
    if (Array.isArray(firstArg) && firstArg.length > 0 && Array.isArray(firstArg[0])) {
      // Common Lisp syntax: (let ((var1 val1) (var2 val2)) body...)
      const bindings = firstArg;
      for (const binding of bindings as Lisp.Atom[]) {
        if (Array.isArray(binding) && binding.length >= 2) {
          const [symbol, value] = binding;
          const symbolName = typeof symbol === "string" ? symbol : String(symbol);
          const expressionResolved = Lisp.evalThrows(value, env); // Evaluate in original env
          
          if (expressionResolved != null) {
            letEnv.set(symbolName, expressionResolved);
          }
        }
      }
      bodyStart = 1;
    } else if (Array.isArray(firstArg) && firstArg[0] === "vector") {
      // Clojure syntax with vector literal: (let [var1 val1 var2 val2 ...] body...)
      const bindings = firstArg.slice(1); // Remove "vector" from the beginning
      if (bindings.length % 2 !== 0) {
        throw new Error("let expects an even number of bindings in vector");
      }
      for (let i = 0; i < bindings.length; i += 2) {
        const symbol = bindings[i];
        const value = bindings[i + 1];
        const symbolName = typeof symbol === "string" ? symbol : String(symbol);
        // Evaluate in letEnv to allow dependent bindings
        const expressionResolved = Lisp.evalThrows(value, letEnv);
        
        if (expressionResolved != null) {
          letEnv.set(symbolName, expressionResolved);
        }
      }
      bodyStart = 1;
    } else if (Array.isArray(firstArg) && firstArg.length % 2 === 0) {
      // Regular array syntax: (let [var1 val1 var2 val2 ...] body...)
      const bindings = firstArg;
      for (let i = 0; i < bindings.length; i += 2) {
        const symbol = bindings[i];
        const value = bindings[i + 1];
        const symbolName = typeof symbol === "string" ? symbol : String(symbol);
        const expressionResolved = Lisp.evalThrows(value, env); // Evaluate in original env
        
        if (expressionResolved != null) {
          letEnv.set(symbolName, expressionResolved);
        }
      }
      bodyStart = 1;
    } else if (typeof firstArg === "string") {
      // Simple syntax: (let var value body...)
      if (args.length < 2) {
        throw new Error("let expects at least var and value");
      }
      const symbolName = firstArg;
      const value = args[1];
      const expressionResolved = Lisp.evalThrows(value, env);
      
      if (expressionResolved != null) {
        letEnv.set(symbolName, expressionResolved);
      }
      bodyStart = 2;
    } else {
      throw new Error("Invalid let syntax");
    }

    // Evaluate body in let environment
    const body = args.slice(bodyStart);
    
    // Special case: if there's no body, just set the variable in the current environment
    // This is for cases like (begin (let a 5) (* a 2))
    if (body.length === 0 && typeof firstArg === "string") {
      const symbolName = firstArg;
      const value = args[1];
      const expressionResolved = Lisp.evalThrows(value, env);
      if (expressionResolved != null) {
        env.set(symbolName, expressionResolved);
      }
      return expressionResolved || 0;
    }
    
    let result: Option<Lisp.Expression> = null;
    for (const expr of body) {
      result = Lisp.evalThrows(expr, letEnv);
    }
    return result || 0;
  },
  begin: (args: Lisp.Atom[], env: Lisp.Environment) => {
    let result: Option<Lisp.Expression> = null;
    for (const arg of args) {
      result = Lisp.evalThrows(arg, env);
    }
    return result;
  },
  defun: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // defun is like define but for functions
    // (defun name (params) body...)
    if (args.length < 3) {
      throw new Error("defun expects at least 3 arguments: name, params, body");
    }
    const [name, params, ...body] = args;
    const funcName = typeof name === "string" ? name : String(name);
    
    // Create a lambda and bind it to the name (like define does)
    const lambda = (procArgs: Lisp.Atom[], procEnv: Lisp.Environment) => {
      // Create new environment with parameters bound
      // The clone already copies all scope entries including user-defined functions
      const newEnv = procEnv.clone(params as string[], procArgs);
      
      // Evaluate body expressions in sequence
      let result: Option<Lisp.Expression> = null;
      for (const expr of body) {
        result = Lisp.evalThrows(expr, newEnv);
      }
      
      return result;
    };
    
    env.set(funcName, lambda);
    return 0; // Return 0 like define does
  },
  cond: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // (cond (test1 expr1) (test2 expr2) ... (else exprN))
    for (const clause of args as Lisp.Atom[][]) {
      if (!Array.isArray(clause) || clause.length < 1) {
        continue;
      }
      
      const [test, ...exprs] = clause;
      
      // Handle 'else' clause (always true)
      if (test === "else") {
        let result: Option<Lisp.Expression> = null;
        for (const expr of exprs) {
          result = Lisp.evalThrows(expr, env);
        }
        return result;
      }
      
      // Evaluate test condition
      const testResult = Lisp.evalThrows(test, env);
      if (Lisp.Utils.isTruthy(testResult)) {
        let result: Option<Lisp.Expression> = null;
        for (const expr of exprs) {
          result = Lisp.evalThrows(expr, env);
        }
        return result;
      }
    }
    return 0; // No clause matched
  },
  and: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // (and expr1 expr2 ... exprN) - returns false if any expr is false, otherwise true
    if (args.length === 0) return true;
    
    for (const arg of args) {
      const result = Lisp.evalThrows(arg, env);
      if (!Lisp.Utils.isTruthy(result)) {
        return false;
      }
    }
    return true;
  },
  or: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // (or expr1 expr2 ... exprN) - returns true if any expr is truthy, otherwise false
    if (args.length === 0) return false;
    
    for (const arg of args) {
      const result = Lisp.evalThrows(arg, env);
      if (Lisp.Utils.isTruthy(result)) {
        return true;
      }
    }
    return false;
  },
});
