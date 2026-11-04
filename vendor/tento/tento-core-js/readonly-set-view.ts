/**
 * A live set as its readers see it: every read (`has`, `size`, iteration,
 * `forEach`, the set-algebra reads) answers from `set` as it is now, and
 * every write refuses — `add` / `delete` / `clear` read `undefined`, a
 * property write or definition fails, and `Set.prototype.add.call(view, x)`
 * throws (the view carries no set slot of its own). What an owner that keeps
 * mutating a set in place hands out behind `ReadonlySet` (a sheet's system
 * row ids, a graph's nodes), so a cast to `Set` reaches no writer.
 *
 * Only the reads are forwarded, each spelled out (`SET_READS`), and none
 * hands `set` itself out: `forEach` passes the VIEW as its callback's third
 * argument; the iterators are `set`'s own, which reach no writer; the
 * set-algebra reads answer a new set. Every other member reads as the view's
 * own — an `Object.prototype` member (`valueOf`, `toString`,
 * `__defineGetter__`, …) runs against the view, never the set, and
 * `Symbol.toStringTag` is `"Set"`.
 *
 * A new view per call: an owner builds it once, next to the set, and hands
 * the same object out.
 */
export function readonlySetView<T>(set: ReadonlySet<T>): ReadonlySet<T> {
  const reads = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  for (const key of SET_READS) {
    const read: unknown = Reflect.get(set, key, set);
    // A set-algebra read the runtime lacks stays missing on the view too.
    if (typeof read === "function") reads.set(key, (...args: unknown[]): unknown => Reflect.apply(read, set, args));
  }
  const forEach = (callbackfn: unknown, thisArg: unknown = undefined): void => {
    if (typeof callbackfn !== "function") throw new TypeError("ReadonlySet.forEach: the callback is not a function");
    for (const value of set) Reflect.apply(callbackfn, thisArg, [value, value, view]);
  };
  const view = new Proxy(set, {
    get(target, key, receiver) {
      if (key === "size") return target.size;
      if (key === "forEach") return forEach;
      if (key === Symbol.toStringTag) return "Set";
      const read = reads.get(key);
      if (read != null) return read;
      // Not a read: nothing of `set`'s. An `Object.prototype` member is
      // answered unbound, so it runs against the view (the receiver).
      return key in Object.prototype ? Reflect.get(Object.prototype, key, receiver) : undefined;
    },
    has: (_target, key) => key === "size" || key === "forEach" || reads.has(key) || key in Object.prototype,
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });
  return view;
}

/** The set members `readonlySetView` forwards besides `size` and `forEach`: the reads that never answer the set itself. */
const SET_READS: readonly PropertyKey[] = Object.freeze([
  "has",
  "entries",
  "keys",
  "values",
  Symbol.iterator,
  "union",
  "intersection",
  "difference",
  "symmetricDifference",
  "isSubsetOf",
  "isSupersetOf",
  "isDisjointFrom",
]);
