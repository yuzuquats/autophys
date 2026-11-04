import { Lisp, flattenLib } from "../lisp";

export const StandardLibraryShared: Map<string, Lisp.Procedure> =
  flattenLib<Lisp.Procedure>({
    // Missing operators from old implementation
    "//": async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a, b] = Lisp.Utils.assertNums(args, "//");
      return Math.floor(a / b);
    },
    "**": async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a, b] = Lisp.Utils.assertNums(args, "**");
      return Math.pow(a, b);
    },

    // Missing math functions
    abs: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "abs");
      return Math.abs(a);
    },
    sqrt: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "sqrt");
      return Math.sqrt(a);
    },
    sin: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "sin");
      return Math.sin(a);
    },
    cos: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "cos");
      return Math.cos(a);
    },
    tan: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "tan");
      return Math.tan(a);
    },
    log: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "log");
      return Math.log(a);
    },
    exp: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "exp");
      return Math.exp(a);
    },
    floor: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "floor");
      return Math.floor(a);
    },
    ceil: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "ceil");
      return Math.ceil(a);
    },
    round: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = Lisp.Utils.assertNums(args, "round");
      return Math.round(a);
    },

    // Constants
    pi: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      return Math.PI;
    },
    euler: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      return Math.E;
    },

    // Logical functions
    not: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [a] = args;
      return !Lisp.Utils.isTruthy(a);
    },
    and: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      for (const arg of args) {
        if (!Lisp.Utils.isTruthy(arg)) return false;
      }
      return true;
    },
    or: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      for (const arg of args) {
        if (Lisp.Utils.isTruthy(arg)) return true;
      }
      return false;
    },

    // List functions
    append: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const result: Lisp.Atom[] = [];
      for (const arg of args) {
        if (Array.isArray(arg)) {
          result.push(...arg);
        } else {
          result.push(arg);
        }
      }
      return result;
    },
    cons: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [head, tail] = args;
      if (Array.isArray(tail)) {
        return [head, ...tail];
      }
      return [head, tail];
    },
    nth: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [list, index] = args;
      if (!Array.isArray(list)) return null as any;
      const idx = Lisp.Utils.assertNum(index, "nth");
      return list[idx] ?? (null as any);
    },
    reverse: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [list] = args;
      if (!Array.isArray(list)) return list;
      return [...list].reverse();
    },
    range: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      if (args.length === 1) {
        const [end] = Lisp.Utils.assertNums(args, "range");
        return Array.from({ length: end }, (_, i) => i);
      } else if (args.length === 2) {
        const [start, end] = Lisp.Utils.assertNums(args, "range");
        return Array.from({ length: end - start }, (_, i) => start + i);
      } else if (args.length === 3) {
        const [start, end, step] = Lisp.Utils.assertNums(args, "range");
        const result: number[] = [];
        for (let i = start; i < end; i += step) {
          result.push(i);
        }
        return result;
      }
      throw new Error("range expects 1, 2, or 3 arguments");
    },

    // Aggregate functions
    max: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const nums = Lisp.Utils.assertNums(args, "max");
      return Math.max(...nums);
    },
    min: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const nums = Lisp.Utils.assertNums(args, "min");
      return Math.min(...nums);
    },

    // Higher-order functions
    filter: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [predicate, list] = args;
      if (!Array.isArray(list)) return [];
      if (typeof predicate !== "function") {
        throw new Error("filter expects a function as first argument");
      }

      const result: Lisp.Atom[] = [];
      for (const item of list) {
        const keep = await (predicate as Lisp.Procedure)([item], env);
        if (Lisp.Utils.isTruthy(keep)) {
          result.push(item);
        }
      }
      return result;
    },
    reduce: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      const [func, list, initial] = args;
      if (!Array.isArray(list)) return initial ?? (null as any);
      if (typeof func !== "function") {
        throw new Error("reduce expects a function as first argument");
      }

      let acc = initial ?? list[0];
      const startIdx = initial !== undefined ? 0 : 1;

      for (let i = startIdx; i < list.length; i++) {
        acc = await (func as Lisp.Procedure)([acc, list[i]], env);
      }
      return acc;
    },

    // Functions that exist in old implementation but not new - keep for compatibility
    print: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      console.log("LISP:", ...args);
      return 0;
    },
    obj: async (
      args: Lisp.Atom[],
      env: Lisp.Environment,
    ): Promise<Lisp.Atom> => {
      return { value: args };
    },
  });
