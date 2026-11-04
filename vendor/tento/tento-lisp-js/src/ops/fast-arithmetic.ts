import { Lisp } from "../lisp";

/**
 * Fast arithmetic operations that avoid Promise overhead when possible.
 * These functions check if all arguments are already numbers and compute
 * synchronously, only falling back to async evaluation when necessary.
 */

export function areAllNumbers(args: Lisp.Atom[]): args is number[] {
  return args.every(arg => typeof arg === "number");
}

async function resolveToNumbers(
  args: Lisp.Atom[], 
  env: Lisp.Environment,
  op: string
): Promise<number[]> {
  const resolved = await Lisp.resolve(args, env);
  return Lisp.Utils.assertNums(resolved, op);
}

export const FastArithmetic = {
  "+": (args: Lisp.Atom[], env: Lisp.Environment): number | Promise<number> => {
    // Ultra-fast path: all arguments are already numbers
    if (areAllNumbers(args)) {
      if (args.length === 0) return 0;
      if (args.length === 1) return args[0];
      if (args.length === 2) return args[0] + args[1];
      
      // Use a for loop for better performance than reduce
      let sum = 0;
      for (let i = 0; i < args.length; i++) {
        sum += args[i];
      }
      return sum;
    }
    
    // Async fallback
    return resolveToNumbers(args, env, "+").then(nums => {
      let sum = 0;
      for (let i = 0; i < nums.length; i++) {
        sum += nums[i];
      }
      return sum;
    });
  },

  "-": (args: Lisp.Atom[], env: Lisp.Environment): number | Promise<number> => {
    // Ultra-fast path: all arguments are already numbers
    if (areAllNumbers(args)) {
      if (args.length === 0) return 0;
      if (args.length === 1) return -args[0];
      if (args.length === 2) return args[0] - args[1];
      
      let result = args[0];
      for (let i = 1; i < args.length; i++) {
        result -= args[i];
      }
      return result;
    }
    
    // Async fallback
    return resolveToNumbers(args, env, "-").then(nums => {
      if (nums.length === 0) return 0;
      if (nums.length === 1) return -nums[0];
      
      let result = nums[0];
      for (let i = 1; i < nums.length; i++) {
        result -= nums[i];
      }
      return result;
    });
  },

  "*": (args: Lisp.Atom[], env: Lisp.Environment): number | Promise<number> => {
    // Ultra-fast path: all arguments are already numbers
    if (areAllNumbers(args)) {
      if (args.length === 0) return 1;
      if (args.length === 1) return args[0];
      if (args.length === 2) return args[0] * args[1];
      
      let product = 1;
      for (let i = 0; i < args.length; i++) {
        product *= args[i];
      }
      return product;
    }
    
    // Async fallback
    return resolveToNumbers(args, env, "*").then(nums => {
      let product = 1;
      for (let i = 0; i < nums.length; i++) {
        product *= nums[i];
      }
      return product;
    });
  },

  "/": (args: Lisp.Atom[], env: Lisp.Environment): number | Promise<number> => {
    // Ultra-fast path: all arguments are already numbers
    if (areAllNumbers(args)) {
      if (args.length === 0) throw new Error("Division requires at least one argument");
      if (args.length === 1) return 1 / args[0];
      if (args.length === 2) return args[0] / args[1];
      
      let result = args[0];
      for (let i = 1; i < args.length; i++) {
        result /= args[i];
      }
      return result;
    }
    
    // Async fallback
    return resolveToNumbers(args, env, "/").then(nums => {
      if (nums.length === 0) throw new Error("Division requires at least one argument");
      
      let result = nums[0];
      for (let i = 1; i < nums.length; i++) {
        result /= nums[i];
      }
      return result;
    });
  },

  "%": (args: Lisp.Atom[], env: Lisp.Environment): number | Promise<number> => {
    // Ultra-fast path: all arguments are already numbers
    if (areAllNumbers(args)) {
      if (args.length !== 2) throw new Error("Modulo requires exactly 2 arguments");
      return args[0] % args[1];
    }
    
    // Async fallback
    return resolveToNumbers(args, env, "%").then(nums => {
      if (nums.length !== 2) throw new Error("Modulo requires exactly 2 arguments");
      return nums[0] % nums[1];
    });
  },

  "**": (args: Lisp.Atom[], env: Lisp.Environment): number | Promise<number> => {
    // Ultra-fast path: all arguments are already numbers
    if (areAllNumbers(args)) {
      if (args.length === 0) return 1;
      if (args.length === 1) return args[0];
      if (args.length === 2) return args[0] ** args[1];
      
      let result = args[0];
      for (let i = 1; i < args.length; i++) {
        result = result ** args[i];
      }
      return result;
    }
    
    // Async fallback
    return resolveToNumbers(args, env, "**").then(nums => {
      if (nums.length === 0) return 1;
      
      let result = nums[0];
      for (let i = 1; i < nums.length; i++) {
        result = result ** nums[i];
      }
      return result;
    });
  },

  "//": (args: Lisp.Atom[], env: Lisp.Environment): number | Promise<number> => {
    // Ultra-fast path: all arguments are already numbers
    if (areAllNumbers(args)) {
      if (args.length === 0) throw new Error("Floor division requires at least one argument");
      if (args.length === 1) return Math.floor(1 / args[0]);
      if (args.length === 2) return Math.floor(args[0] / args[1]);
      
      let result = args[0];
      for (let i = 1; i < args.length; i++) {
        result /= args[i];
      }
      return Math.floor(result);
    }
    
    // Async fallback
    return resolveToNumbers(args, env, "//").then(nums => {
      if (nums.length === 0) throw new Error("Floor division requires at least one argument");
      
      let result = nums[0];
      for (let i = 1; i < nums.length; i++) {
        result /= nums[i];
      }
      return Math.floor(result);
    });
  }
};