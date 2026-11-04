import { Tracing } from "./tracing";

export const assert = (cond: boolean, message?: string) => {
  if (!cond) {
    console.error(message);
    throw new Error(message);
  }
};

export const assertEqual = (o1: any, o2: any, message?: string) => {
  if (o1 !== o2) {
    console.error(o1, "is not equal to", o2, message);
    throw new Error(`${o1} !=  ${o2}`);
  }
};

// NaN is treated as null: surfacing broken arithmetic at the unwrap site
// is more useful than letting NaN propagate silently through downstream math.
export const nonnull = <T>(val: Option<T>, message?: string): T => {
  // @ts-ignore
  if (
    val == null ||
    val === undefined ||
    (typeof val === "number" && Number.isNaN(val))
  ) {
    message = message ?? `Got null or NaN value: ${val}`;
    console.error(message);
    throw new Error(message);
  }
  return val;
};

export const nonnull_noexcept = <T>(val: Option<T>, message?: string): T => {
  // @ts-ignore
  if (val == null || (typeof val === "number" && Number.isNaN(val))) {
    message = message ?? "Got null or NaN value";
    console.trace();
    console.error(message);
  }
  return val as T;
};

/**
 * Error type thrown by `invariant`. Carries a structured `context` bag
 * (event ids, row keys, caller method names, etc.) so callers higher
 * in the stack — and `Tracing.log("invariant-violation", …)` consumers
 * — can locate the violation without parsing free-form messages.
 */
export class InvariantViolation extends Error {
  readonly context: Option<Record<string, unknown>>;

  constructor(message: string, context: Option<Record<string, unknown>>) {
    super(message);
    this.name = "InvariantViolation";
    this.context = context;
  }
}

/**
 * Hard precondition check. Replaces silent `return null` / `return;`
 * at sites where a missing dependency means the code is genuinely
 * broken — not a legitimate "ask for X, get nothing if absent" query.
 *
 * Required `message` names the violated condition; optional `context`
 * carries the runtime values that make the violation locatable
 * (event id, row key, caller method, etc.).
 *
 * On violation:
 *   1. Emits `Tracing.log("invariant-violation", { message, ...context })`
 *      so the failure shows up in ux-test session logs even when the
 *      exception is caught upstream.
 *   2. Throws `InvariantViolation`. The Error itself carries the
 *      structured `context` for any handler that catches and inspects.
 *
 * Prefer `invariant` over `assert` at new call sites — the required
 * message + optional context make failures diagnosable in production
 * logs.
 */
export function invariant(
  cond: unknown,
  message: string,
  context: Option<Record<string, unknown>> = null,
): asserts cond {
  if (cond) return;
  // Emit at "error" level so ux-test runners with
  // `auto_fail_on_errors: true` catch the violation without
  // each test having to declare it in `forbidden_logs`.
  Tracing.span("invariant-violation", (s) => {
    s.record("message", message);
    if (context) {
      for (const [k, v] of Object.entries(context)) s.record(k, v);
    }
    Tracing.setLevel("error");
  });
  throw new InvariantViolation(message, context);
}
