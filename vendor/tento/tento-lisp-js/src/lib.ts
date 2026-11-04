/**
 * `@tento-lisp` — Lisp evaluator (parser + interpreter + stdlib).
 *
 * Public re-exports are intentionally narrow: most call sites either
 * use `Lisp.run` / `Lisp.parse` directly, or import a specific stdlib
 * group from `@tento-lisp/ops/...`.
 */

export { Lisp, flattenLib, OptFlags } from "./lisp.ts";
export { ControlFlow } from "./ops/control-flow.ts";
export { StandardLibrary } from "./ops/stdlib.ts";
export { BracketNotationUtils } from "./bracket-notation-utils.ts";
