export namespace Constants {
  /** @deprecated Use `ZIndex.*` tokens from `@tento-ui/z-index` instead. */
  export const MAX_Z_INDEX = 16777271;
  export function IDENTITY_FUNC<T>(a: T) {
    return a;
  }
  export const EMPTY_FUNCTION = () => {};
  export const EMPTY_FUNCTION_ASYNC = async () => {};

  /**
   * Symbol to explicitly clear a field to null.
   * Use this instead of passing null directly to distinguish between
   * "field not provided" (undefined) vs "field explicitly cleared" (CLEAR).
   *
   * Example:
   *   update.timezone = Constants.CLEAR; // explicitly clear timezone
   *   update.timezone = "America/LA";    // set to value
   *   // not setting update.timezone     // don't change
   */
  export const CLEAR: unique symbol = Symbol("CLEAR");
  export type Clearable<T> = T | typeof CLEAR;

  /** Check if a value is the CLEAR symbol */
  export function isClear(value: unknown): value is typeof CLEAR {
    return value === CLEAR;
  }

  /** Convert Clearable<T> to Option<T> (CLEAR becomes null) */
  export function resolveClearable<T>(value: Clearable<T>): Option<T> {
    return value === CLEAR ? null : value;
  }

  /** Resolve all CLEAR symbols in an object to null (for JSON serialization) */
  export function resolveAllClearable<T extends object>(obj: T): T {
    const result = { ...obj } as any;
    for (const key in result) {
      if (isClear(result[key])) {
        result[key] = null;
      }
    }
    return result;
  }
}
