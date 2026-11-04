import { Lisp, flattenLib } from "../lisp";
import { BatchOperations } from "./batch-operations";
import { OptimizedStdLib } from "./optimized-stdlib";

// Shared function implementations
const firstImpl = (args: Lisp.Atom[], env: Lisp.Environment) => {
  const rargs = Lisp.resolve(args, env);
  if (!Array.isArray(rargs[0])) {
    throw new Error("first/car expects a list");
  }
  return (rargs[0] as Lisp.Atom[])[0];
};

const restImpl = (args: Lisp.Atom[], env: Lisp.Environment) => {
  const rargs = Lisp.resolve(args, env);
  if (!Array.isArray(rargs[0])) {
    throw new Error("rest/cdr expects a list");
  }
  return (rargs[0] as Lisp.Atom[]).slice(1);
};

const reduceImpl = (args: Lisp.Atom[], env: Lisp.Environment) => {
  return BatchOperations.optimizedReduce(args, env);
};

export const StandardLibrary = flattenLib<Lisp.Procedure>({
  "+": (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for common cases
    if (
      args.length === 2 &&
      typeof args[0] === "number" &&
      typeof args[1] === "number"
    ) {
      return args[0] + args[1];
    }
    const nums = Lisp.resolve(args, env);
    return Lisp.Utils.assertNums(nums, "+").reduce((a, c) => a + c, 0);
  },
  "-": (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for common cases
    if (
      args.length === 2 &&
      typeof args[0] === "number" &&
      typeof args[1] === "number"
    ) {
      return args[0] - args[1];
    }
    const nums = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(nums, "-");
    return assertedNums.reduce((a, c) => a - c);
  },
  "*": (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for common cases
    if (
      args.length === 2 &&
      typeof args[0] === "number" &&
      typeof args[1] === "number"
    ) {
      return args[0] * args[1];
    }
    const nums = Lisp.resolve(args, env);
    return Lisp.Utils.assertNums(nums, "*").reduce((a, c) => a * c, 1);
  },
  "/": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const nums = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(nums, "/");
    return assertedNums.reduce((a, c) => a / c);
  },
  "//": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const nums = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(nums, "//");
    return Math.floor(assertedNums.reduce((a, c) => a / c));
  },
  "%": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const nums = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(nums, "%");
    return assertedNums.reduce((a, c) => a % c);
  },
  "**": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const nums = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(nums, "**");
    return assertedNums.reduce((a, c) => a ** c);
  },
  "=": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    // Deep equality comparison
    const deepEqual = (a: any, b: any): boolean => {
      if (a === b) return true;
      if (a == null || b == null) return false;
      if (typeof a !== typeof b) return false;
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
          if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
      }
      if (typeof a === "object" && typeof b === "object") {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
          if (!deepEqual(a[key], b[key])) return false;
        }
        return true;
      }
      return false;
    };

    for (let i = 1; i < rargs.length; i++) {
      if (!deepEqual(rargs[0], rargs[i])) return false;
    }
    return true;
  },
  "!=": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    return rargs[0] !== rargs[1];
  },
  ">": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(rargs, ">");
    return assertedNums[0] > assertedNums[1];
  },
  "<": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(rargs, "<");
    return assertedNums[0] < assertedNums[1];
  },
  ">=": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(rargs, ">=");
    return assertedNums[0] >= assertedNums[1];
  },
  "<=": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const assertedNums = Lisp.Utils.assertNums(rargs, "<=");
    return assertedNums[0] <= assertedNums[1];
  },
  and: (args: Lisp.Atom[], env: Lisp.Environment) => {
    for (const arg of args) {
      const val = Lisp.evalThrows(arg, env);
      if (!Lisp.Utils.isTruthy(val)) return false;
    }
    return true;
  },
  or: (args: Lisp.Atom[], env: Lisp.Environment) => {
    for (const arg of args) {
      const val = Lisp.evalThrows(arg, env);
      if (Lisp.Utils.isTruthy(val)) return true;
    }
    return false;
  },
  not: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    return !Lisp.Utils.isTruthy(rargs[0]);
  },
  list: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Always use the standard resolve path to handle StringLiteral objects correctly
    return Lisp.resolve(args, env);
  },
  vector: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // vector creates an array from its arguments (same as list for JSON compatibility)
    return Lisp.resolve(args, env);
  },
  apply: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // apply takes a function and a list of arguments, and applies the function to those arguments
    if (args.length < 2) {
      throw new Error(
        "apply requires at least 2 arguments: function and args list",
      );
    }

    const [fnAtom, ...restArgs] = args;
    const lastArg = restArgs[restArgs.length - 1];

    // Resolve the last argument which should be a list/array
    const resolvedLast = Lisp.resolve([lastArg], env)[0];
    if (!Array.isArray(resolvedLast)) {
      throw new Error("Last argument to apply must be a list");
    }

    // Build the final argument list: all args except the last, plus the expanded last arg
    const finalArgs = [
      ...restArgs.slice(0, -1).map((arg) => Lisp.resolve([arg], env)[0]),
      ...resolvedLast,
    ];

    // Call the function with the expanded arguments
    return Lisp.evalThrows([fnAtom, ...finalArgs], env);
  },
  "hash-map": (args: Lisp.Atom[], env: Lisp.Environment) => {
    // hash-map creates a JSON object from key-value pairs
    const rargs = Lisp.resolve(args, env);
    if (rargs.length % 2 !== 0) {
      throw new Error("hash-map expects an even number of arguments");
    }
    const obj: any = {};
    for (let i = 0; i < rargs.length; i += 2) {
      let key = String(rargs[i]);
      // Remove leading colon from keywords
      if (key.startsWith(":")) {
        key = key.substring(1);
      }
      obj[key] = rargs[i + 1];
    }
    return obj;
  },
  count: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const coll = rargs[0];
    if (Array.isArray(coll)) {
      return coll.length;
    } else if (coll && typeof coll === "object") {
      return Object.keys(coll).length;
    }
    return 0;
  },
  "empty?": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const coll = rargs[0];
    if (Array.isArray(coll)) {
      return coll.length === 0;
    } else if (coll && typeof coll === "object") {
      return Object.keys(coll).length === 0;
    }
    return true;
  },
  get: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const [coll, key, notFound = null] = rargs;

    if (Array.isArray(coll) && typeof key === "number") {
      return coll[key] ?? notFound;
    } else if (coll && typeof coll === "object") {
      let keyStr = String(key);
      // Remove leading colon from keywords
      if (keyStr.startsWith(":")) {
        keyStr = keyStr.substring(1);
      }
      return (coll as any)[keyStr] ?? notFound;
    }
    return notFound;
  },
  assoc: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    if (rargs.length < 3 || (rargs.length - 1) % 2 !== 0) {
      throw new Error("assoc expects a map followed by key-value pairs");
    }

    const map = rargs[0];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new Error("assoc expects a map as first argument");
    }

    const result = { ...map };
    for (let i = 1; i < rargs.length; i += 2) {
      let key = String(rargs[i]);
      if (key.startsWith(":")) {
        key = key.substring(1);
      }
      result[key] = rargs[i + 1];
    }
    return result;
  },
  dissoc: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    if (rargs.length < 2) {
      throw new Error("dissoc expects a map and at least one key");
    }

    const map = rargs[0];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new Error("dissoc expects a map as first argument");
    }

    const result = { ...map };
    for (let i = 1; i < rargs.length; i++) {
      let key = String(rargs[i]);
      if (key.startsWith(":")) {
        key = key.substring(1);
      }
      delete result[key];
    }
    return result;
  },
  keys: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const map = rargs[0];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new Error("keys expects a map");
    }
    return Object.keys(map);
  },
  vals: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const map = rargs[0];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new Error("vals expects a map");
    }
    return Object.values(map);
  },
  slice: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const [arr, startAtom, endAtom] = rargs;

    if (!Array.isArray(arr)) {
      throw new Error("slice expects an array as first argument");
    }

    // Handle different argument counts
    if (rargs.length === 2) {
      // Only start index provided - slice to end
      const start = typeof startAtom === "number" ? startAtom : 0;
      return arr.slice(start);
    } else if (rargs.length === 3) {
      // Both start and end provided
      const start = typeof startAtom === "number" ? startAtom : 0;
      const end = typeof endAtom === "number" ? endAtom : arr.length;
      return arr.slice(start, end);
    } else {
      throw new Error(
        "slice expects 2 or 3 arguments: array, start, and optional end",
      );
    }
  },
  conj: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    if (rargs.length < 2) {
      throw new Error("conj expects a collection and at least one element");
    }

    const [coll, ...elements] = rargs;

    if (Array.isArray(coll)) {
      // For vectors/lists, add to the end
      return [...coll, ...elements];
    } else if (coll && typeof coll === "object") {
      // For maps, expect [key value] pairs or merge objects
      const result = { ...coll };
      for (const elem of elements) {
        if (Array.isArray(elem) && elem.length === 2) {
          let key = String(elem[0]);
          if (key.startsWith(":")) {
            key = key.substring(1);
          }
          result[key] = elem[1];
        } else if (elem && typeof elem === "object" && !Array.isArray(elem)) {
          // Merge objects
          Object.assign(result, elem);
        } else {
          throw new Error("conj on map expects [key value] pairs or objects");
        }
      }
      return result;
    }

    // If coll is null/undefined, create a new vector
    return elements;
  },
  first: firstImpl,
  car: firstImpl, // car is an alias for first
  rest: restImpl,
  cdr: restImpl, // cdr is an alias for rest
  length: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    return (rargs[0] as Lisp.Atom[]).length;
  },
  append: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    // append concatenates lists together
    let result: any[] = [];
    for (const arg of rargs) {
      if (Array.isArray(arg)) {
        result = [...result, ...arg];
      } else if (arg != null) {
        // If not a list, treat as a single element
        result.push(arg);
      }
    }
    return result;
  },
  cons: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const [item, list] = rargs;
    if (!Array.isArray(list)) {
      throw new Error("Second argument to cons must be a list");
    }
    return [item, ...list];
  },
  map: (args: Lisp.Atom[], env: Lisp.Environment) => {
    return BatchOperations.optimizedMap(args, env);
  },
  filter: (args: Lisp.Atom[], env: Lisp.Environment) => {
    return BatchOperations.optimizedFilter(args, env);
  },
  reduce: reduceImpl,
  fold: reduceImpl, // fold is an alias for reduce
  "group-by": (args: Lisp.Atom[], env: Lisp.Environment) => {
    // (group-by keyFn coll) → list of [key, [items…]] pairs. `keyFn` is
    // applied to each item; items with an equal key (by value) share a
    // bucket. Buckets are returned in first-occurrence order of the key
    // (so a pre-sorted `coll` yields sorted buckets). Mirrors the Rust
    // `special_group_by`; see tento-lisp-tests fixtures.
    const [fn, list] = args;
    const resolved = Lisp.evalThrows(list, env);
    if (resolved == null) return [];
    if (!Array.isArray(resolved)) {
      throw new Error("Second argument to group-by must be a list");
    }
    const order: Lisp.Atom[] = [];
    const buckets = new Map<string, Lisp.Atom[]>();
    for (const item of resolved) {
      const key = Lisp.evalThrows([fn, ["quote", item]], env) as Lisp.Atom;
      const k = JSON.stringify(key ?? null);
      let bucket = buckets.get(k);
      if (!bucket) {
        bucket = [];
        buckets.set(k, bucket);
        order.push(key);
      }
      bucket.push(item as Lisp.Atom);
    }
    return order.map((key) => [key, buckets.get(JSON.stringify(key ?? null))!]);
  },
  nth: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const [list, n] = rargs;
    if (!Array.isArray(list)) {
      throw new Error("First argument to nth must be a list");
    }
    const index = Lisp.Utils.assertNum(n, "nth");
    return list[index];
  },
  concat: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path if all arguments are already strings or numbers
    if (
      args.every((arg) => typeof arg === "string" || typeof arg === "number")
    ) {
      return OptimizedStdLib.concat(...args);
    }
    const rargs = Lisp.resolve(args, env);
    const strArgs = rargs.map((arg) => {
      if (arg == null || arg === undefined) return "";
      return String(arg);
    });
    return strArgs.join("");
  },
  str: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // str is an alias for concat - concatenate all arguments into a string
    // Always resolve arguments first to handle variables correctly
    const rargs = Lisp.resolve(args, env);
    const strArgs = rargs.map((arg) => {
      if (arg == null || arg === undefined) return "";
      return String(arg);
    });
    return strArgs.join("");
  },
  mod: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const numberArgs = Lisp.Utils.assertNums(rargs, "mod");
    return numberArgs[0] % numberArgs[1];
  },
  len: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path if argument is already resolved primitive (not a quoted expression)
    if (
      args.length === 1 &&
      (typeof args[0] === "string" || typeof args[0] === "number")
    ) {
      return OptimizedStdLib.len(args[0]);
    }

    const rargs = Lisp.resolve(args, env);
    const arg = rargs[0];
    if (Array.isArray(arg)) {
      return arg.length;
    }
    if (typeof arg === "string") {
      return arg.length;
    }
    if (typeof arg === "number") {
      // Convert number to string and return its length
      return String(arg).length;
    }
    // For objects, return the number of keys
    if (typeof arg === "object" && arg !== null) {
      return Object.keys(arg).length;
    }
    return 0;
  },
  field: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    if (typeof rargs[0] !== "object") return 0;
    if (typeof rargs[1] !== "string") return 0;
    if (!rargs[0]) return 0;
    return (rargs[0] as any)[rargs[1]];
  },
  sin: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    return Math.sin(Lisp.Utils.assertNum(rargs[0], "sin"));
  },
  cos: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    return Math.cos(Lisp.Utils.assertNum(rargs[0], "cos"));
  },
  tan: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    return Math.tan(Lisp.Utils.assertNum(rargs[0], "tan"));
  },
  log: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    return Math.log(Lisp.Utils.assertNum(rargs[0], "log"));
  },
  exp: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    return Math.exp(Lisp.Utils.assertNum(rargs[0], "exp"));
  },
  pi: () => Math.PI,
  euler: () => Math.E,

  // JSON functions
  json: (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Create JSON object from alternating key-value pairs
    if (args.length % 2 !== 0) {
      throw new Error(
        "json expects even number of arguments (key-value pairs)",
      );
    }
    const rargs = Lisp.resolve(args, env);
    const obj: any = {};
    for (let i = 0; i < rargs.length; i += 2) {
      let key = String(rargs[i]);
      // Remove leading colon if present (keyword style)
      if (key.startsWith(":")) {
        key = key.substring(1);
      }
      const value = rargs[i + 1];
      obj[key] = value;
    }
    return obj;
  },

  "json-get": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Get value from JSON object by key
    if (args.length !== 2) {
      throw new Error("json-get expects 2 arguments: object and key");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    let key = String(rargs[1]);
    // Remove leading colon if present (keyword style)
    if (key.startsWith(":")) {
      key = key.substring(1);
    }
    if (typeof obj !== "object" || obj === null) {
      return null as any;
    }
    const value = (obj as any)[key];
    return value !== undefined ? value : (null as any);
  },

  "json-set": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Set value in JSON object
    if (args.length !== 3) {
      throw new Error("json-set expects 3 arguments: object, key, value");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    let key = String(rargs[1]);
    // Remove leading colon if present (keyword style)
    if (key.startsWith(":")) {
      key = key.substring(1);
    }
    if (typeof obj !== "object" || obj === null) {
      throw new Error("json-set expects first argument to be an object");
    }
    // Create a new object with the updated value (immutable)
    return { ...obj, [key]: rargs[2] };
  },

  "json-keys": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Get all keys from JSON object
    if (args.length !== 1) {
      throw new Error("json-keys expects 1 argument");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    if (typeof obj !== "object" || obj === null) {
      return [];
    }
    return Object.keys(obj);
  },

  "json-values": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Get all values from JSON object
    if (args.length !== 1) {
      throw new Error("json-values expects 1 argument");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    if (typeof obj !== "object" || obj === null) {
      return [];
    }
    return Object.values(obj);
  },

  "json-has-key": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Check if JSON object has a key
    if (args.length !== 2) {
      throw new Error("json-has-key expects 2 arguments: object and key");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    let key = String(rargs[1]);
    // Remove leading colon if present (keyword style)
    if (key.startsWith(":")) {
      key = key.substring(1);
    }
    if (typeof obj !== "object" || obj === null) {
      return false;
    }
    return key in obj;
  },

  "json-remove": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Remove a key from JSON object
    if (args.length !== 2) {
      throw new Error("json-remove expects 2 arguments: object and key");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    let key = String(rargs[1]);
    // Remove leading colon if present (keyword style)
    if (key.startsWith(":")) {
      key = key.substring(1);
    }
    if (typeof obj !== "object" || obj === null) {
      return 0;
    }
    // Create a new object without the key
    const newObj = { ...obj };
    delete (newObj as any)[key];
    return newObj;
  },

  "json-merge": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Merge two or more JSON objects
    if (args.length < 2) {
      throw new Error("json-merge expects at least 2 arguments");
    }
    const rargs = Lisp.resolve(args, env);
    let result = {};
    for (const arg of rargs) {
      if (typeof arg === "object" && arg !== null && !Array.isArray(arg)) {
        result = { ...result, ...arg };
      }
    }
    return result;
  },

  "json-size": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Get the number of keys in JSON object
    if (args.length !== 1) {
      throw new Error("json-size expects 1 argument");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    if (typeof obj !== "object" || obj === null) {
      return 0;
    }
    return Object.keys(obj).length;
  },

  "json-stringify": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Convert JSON object to string
    if (args.length !== 1) {
      throw new Error("json-stringify expects 1 argument");
    }
    const rargs = Lisp.resolve(args, env);
    return JSON.stringify(rargs[0]);
  },

  "json-parse": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Parse JSON string to object
    if (args.length !== 1) {
      throw new Error("json-parse expects 1 argument");
    }
    const rargs = Lisp.resolve(args, env);
    const str = String(rargs[0]);
    try {
      return JSON.parse(str);
    } catch (e) {
      throw new Error(
        `json-parse: invalid JSON string - ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },

  "json-empty?": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Check if JSON object is empty
    if (args.length !== 1) {
      throw new Error("json-empty? expects 1 argument");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    if (typeof obj !== "object" || obj === null) {
      return true;
    }
    return Object.keys(obj).length === 0;
  },

  "json-from-list": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Create JSON object from alternating key-value list
    if (args.length !== 1) {
      throw new Error("json-from-list expects 1 argument");
    }
    const rargs = Lisp.resolve(args, env);
    const list = rargs[0];
    if (!Array.isArray(list)) {
      throw new Error("json-from-list expects a list");
    }
    const obj: any = {};
    for (let i = 0; i < list.length; i += 2) {
      if (i + 1 >= list.length) {
        throw new Error(
          "json-from-list expects even number of elements in list",
        );
      }
      let key = String(list[i]);
      // Remove leading colon if present (keyword style)
      if (key.startsWith(":")) {
        key = key.substring(1);
      }
      let value = list[i + 1];
      // Handle StringLiteral values
      if (value instanceof Lisp.StringLiteral) {
        value = value.value;
      }
      // If value is a list starting with a function name, evaluate it
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        typeof value[0] === "string"
      ) {
        // This looks like a function call that needs evaluation
        value = Lisp.evalThrows(value, env);
      }
      obj[key] = value;
    }
    return obj;
  },

  "json-to-list": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Convert JSON object to alternating key-value list
    if (args.length !== 1) {
      throw new Error("json-to-list expects 1 argument");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    if (typeof obj !== "object" || obj === null) {
      return [];
    }
    const result: any[] = [];
    for (const [key, value] of Object.entries(obj)) {
      result.push(key, value);
    }
    return result;
  },

  "json-get-in": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Get nested value from JSON object using a path
    if (args.length !== 2) {
      throw new Error("json-get-in expects 2 arguments: object and path");
    }
    const rargs = Lisp.resolve(args, env);
    let obj = rargs[0];
    const path = rargs[1];
    if (!Array.isArray(path)) {
      throw new Error("json-get-in expects path to be a list");
    }
    for (const key of path) {
      if (typeof obj !== "object" || obj === null) {
        // Missing nested path → nil, matching `json-get` and the Rust
        // `json_get_in` (`Value::Nil`). (Was `0`, a JS-only divergence
        // that made a missing field indistinguishable from a real 0.)
        return null as any;
      }
      obj = (obj as any)[String(key)];
    }
    return obj ?? (null as any);
  },

  "json-set-in": (args: Lisp.Atom[], env: Lisp.Environment): Lisp.Atom => {
    // Set nested value in JSON object using a path
    if (args.length !== 3) {
      throw new Error("json-set-in expects 3 arguments: object, path, value");
    }
    const rargs = Lisp.resolve(args, env);
    const obj = rargs[0];
    const path = rargs[1];
    const value = rargs[2];

    if (!Array.isArray(path) || path.length === 0) {
      throw new Error("json-set-in expects non-empty path list");
    }
    if (typeof obj !== "object" || obj === null) {
      throw new Error("json-set-in expects first argument to be an object");
    }

    // Deep clone the object to maintain immutability
    const deepClone = (o: any): any => {
      if (o === null || typeof o !== "object") return o;
      if (Array.isArray(o)) return o.map(deepClone);
      const cloned: any = {};
      for (const key in o) {
        cloned[key] = deepClone(o[key]);
      }
      return cloned;
    };

    const result = deepClone(obj);
    let current = result;

    // Navigate to the parent of the target
    for (let i = 0; i < path.length - 1; i++) {
      const key = String(path[i]);
      if (
        !(key in current) ||
        typeof current[key] !== "object" ||
        current[key] === null
      ) {
        current[key] = {};
      }
      current = current[key];
    }

    // Set the final value
    current[String(path[path.length - 1])] = value;
    return result;
  },
  // New optimized math functions
  min: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for numbers
    if (args.every((arg) => typeof arg === "number")) {
      return OptimizedStdLib.min(...(args as number[]));
    }
    const rargs = Lisp.resolve(args, env);
    const nums = Lisp.Utils.assertNums(rargs, "min");
    return OptimizedStdLib.min(...nums);
  },
  max: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for numbers
    if (args.every((arg) => typeof arg === "number")) {
      return OptimizedStdLib.max(...(args as number[]));
    }
    const rargs = Lisp.resolve(args, env);
    const nums = Lisp.Utils.assertNums(rargs, "max");
    return OptimizedStdLib.max(...nums);
  },
  abs: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for number
    if (args.length === 1 && typeof args[0] === "number") {
      return OptimizedStdLib.abs(args[0]);
    }
    const rargs = Lisp.resolve(args, env);
    const num = Lisp.Utils.assertNum(rargs[0], "abs");
    return OptimizedStdLib.abs(num);
  },
  floor: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for number
    if (args.length === 1 && typeof args[0] === "number") {
      return OptimizedStdLib.floor(args[0]);
    }
    const rargs = Lisp.resolve(args, env);
    const num = Lisp.Utils.assertNum(rargs[0], "floor");
    return OptimizedStdLib.floor(num);
  },
  ceil: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for number
    if (args.length === 1 && typeof args[0] === "number") {
      return OptimizedStdLib.ceil(args[0]);
    }
    const rargs = Lisp.resolve(args, env);
    const num = Lisp.Utils.assertNum(rargs[0], "ceil");
    return OptimizedStdLib.ceil(num);
  },
  round: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for number
    if (args.length === 1 && typeof args[0] === "number") {
      return OptimizedStdLib.round(args[0]);
    }
    const rargs = Lisp.resolve(args, env);
    const num = Lisp.Utils.assertNum(rargs[0], "round");
    return OptimizedStdLib.round(num);
  },
  sqrt: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for number
    if (args.length === 1 && typeof args[0] === "number") {
      return OptimizedStdLib.sqrt(args[0]);
    }
    const rargs = Lisp.resolve(args, env);
    const num = Lisp.Utils.assertNum(rargs[0], "sqrt");
    return OptimizedStdLib.sqrt(num);
  },
  // New optimized list functions
  reverse: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    if (!Array.isArray(rargs[0])) {
      throw new Error("reverse expects a list");
    }
    return OptimizedStdLib.reverse(rargs[0]);
  },
  range: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path for numbers
    if (args.every((arg) => typeof arg === "number")) {
      const [start, end, step] = args as number[];
      return OptimizedStdLib.range(start, end, step);
    }
    const rargs = Lisp.resolve(args, env);
    const nums = Lisp.Utils.assertNums(rargs, "range");
    return OptimizedStdLib.range(nums[0], nums[1], nums[2]);
  },
  take: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path if arguments are already resolved
    if (
      args.length === 2 &&
      typeof args[0] === "number" &&
      Array.isArray(args[1])
    ) {
      return OptimizedStdLib.take(args[0], args[1]);
    }
    const rargs = Lisp.resolve(args, env);
    const n = Lisp.Utils.assertNum(rargs[0], "take");
    if (!Array.isArray(rargs[1])) {
      throw new Error("take expects a list as second argument");
    }
    return OptimizedStdLib.take(n, rargs[1]);
  },
  drop: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path if arguments are already resolved
    if (
      args.length === 2 &&
      typeof args[0] === "number" &&
      Array.isArray(args[1])
    ) {
      return OptimizedStdLib.drop(args[0], args[1]);
    }
    const rargs = Lisp.resolve(args, env);
    const n = Lisp.Utils.assertNum(rargs[0], "drop");
    if (!Array.isArray(rargs[1])) {
      throw new Error("drop expects a list as second argument");
    }
    return OptimizedStdLib.drop(n, rargs[1]);
  },
  unique: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    if (!Array.isArray(rargs[0])) {
      throw new Error("unique expects a list");
    }
    return OptimizedStdLib.unique(rargs[0]);
  },
  flatten: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    if (!Array.isArray(rargs[0])) {
      throw new Error("flatten expects a list");
    }
    const depth =
      rargs[1] !== undefined
        ? Lisp.Utils.assertNum(rargs[1], "flatten depth")
        : 1;
    return OptimizedStdLib.flatten(rargs[0], depth);
  },
  sort: (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    if (!Array.isArray(rargs[0])) {
      throw new Error("sort expects a list");
    }
    return OptimizedStdLib.sort(rargs[0]);
  },
  includes: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path if arguments are already resolved
    if (args.length === 2 && Array.isArray(args[0])) {
      return OptimizedStdLib.includes(args[0], args[1]);
    }
    const rargs = Lisp.resolve(args, env);
    if (!Array.isArray(rargs[0])) {
      return false;
    }
    const searchValue = rargs[1];
    if (searchValue == null) {
      return false;
    }
    return OptimizedStdLib.includes(rargs[0], searchValue);
  },
  zip: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // Fast path if all arguments are already lists
    if (args.every((arg) => Array.isArray(arg))) {
      return OptimizedStdLib.zip(...(args as Lisp.Atom[][]));
    }
    const rargs = Lisp.resolve(args, env);
    if (!rargs.every((arg) => Array.isArray(arg))) {
      throw new Error("zip expects all arguments to be lists");
    }
    return OptimizedStdLib.zip(...(rargs as Lisp.Atom[][]));
  },

  // Additional Lisp functions
  "null?": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const val = rargs[0];
    return val == null || (Array.isArray(val) && val.length === 0);
  },
  "atom?": (args: Lisp.Atom[], env: Lisp.Environment) => {
    const rargs = Lisp.resolve(args, env);
    const val = rargs[0];
    return !Array.isArray(val);
  },
  cond: (args: Lisp.Atom[], env: Lisp.Environment) => {
    // cond is like a series of if-else statements
    for (const clause of args as Lisp.Atom[][]) {
      if (!Array.isArray(clause) || clause.length < 2) {
        continue;
      }
      const [test, ...body] = clause;

      // Check for else clause
      if (test === "else" || (typeof test === "string" && test === "else")) {
        let result: Option<Lisp.Expression> = null;
        for (const expr of body) {
          result = Lisp.evalThrows(expr, env);
        }
        return result;
      }

      const testResult = Lisp.evalThrows(test, env);
      if (Lisp.Utils.isTruthy(testResult)) {
        let result: Option<Lisp.Expression> = null;
        for (const expr of body) {
          result = Lisp.evalThrows(expr, env);
        }
        return result;
      }
    }
    return null as any;
  },
  else: () => {
    // else is handled in cond, this is just a placeholder
    return true;
  },
});
