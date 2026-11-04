/**
 * Dev-only deep freeze for flowing pipeline artifacts (engine-spec §3:
 * messages are immutable; stations are not). No-op unless enabled, so
 * production paths pay nothing. Enable in test harnesses only.
 */
export namespace ArtifactFreeze {
  let enabled = false;

  export function enable(): void {
    enabled = true;
  }

  export function isEnabled(): boolean {
    return enabled;
  }

  /**
   * Recursively `Object.freeze` the plain objects and arrays reachable from
   * `value`. Class instances, `Map`s, `Set`s, and functions are left alone —
   * traversal does not descend into them, they are not frozen. Cycle-safe via
   * a `WeakSet` of already-visited objects. No-op (returns `value` untouched,
   * zero traversal) unless `enable()` has been called. Returns the input.
   */
  export function deep<T>(value: T): T {
    if (!enabled) return value;
    if (value !== null && typeof value === "object") freezeObject(value, new WeakSet<object>());
    return value;
  }

  /** Freeze + recurse into a plain object/array already known to be `object`. */
  function freezeObject(obj: object, seen: WeakSet<object>): void {
    if (seen.has(obj)) return;
    if (!isPlain(obj)) return;
    seen.add(obj);
    Object.freeze(obj);
    if (isPlainArray(obj)) {
      for (const item of obj) {
        if (item !== null && typeof item === "object") freezeObject(item, seen);
      }
      return;
    }
    const record: Record<string, object> = obj as Record<string, object>;
    for (const key of Object.keys(obj)) {
      const propValue = record[key];
      if (propValue !== null && typeof propValue === "object") freezeObject(propValue, seen);
    }
  }

  /** A plain array — one of the two shapes traversal descends into. */
  function isPlainArray(obj: object): obj is ReadonlyArray<object> {
    return Array.isArray(obj);
  }

  /** A plain array or a plain `{}` (own or `null` prototype) — never a class
   *  instance, `Map`, `Set`, or function. */
  function isPlain(obj: object): boolean {
    if (Array.isArray(obj)) return true;
    const proto = Object.getPrototypeOf(obj);
    return proto === Object.prototype || proto === null;
  }
}
