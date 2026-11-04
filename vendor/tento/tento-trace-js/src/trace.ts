/**
 * `Trace` — a single-name convenience surface over the observability package.
 *
 * Console logging and span tracing remain two distinct call shapes underneath
 * (that is deliberate: collapsing them would force every console call through a
 * wrapper and lose devtools source lines). This facade just gathers both under
 * one object for ergonomics in new code.
 *
 * The console accessors are **getters** because `Logger.info`/`warn`/`err`/`dbg`
 * are reassigned at runtime by `Logger._reinstall()` (pure-bind vs wrapped). A
 * getter returns the *current* binding, so `Trace.info(cat)(...args)` invokes the
 * live `console.log.bind(...)` directly at the call site — source lines intact.
 */
import { type LogFunction, type LogFunctionWithCategory, Logger } from "./log";
import { captureConsoleIntoTracing } from "./console-sink";
import { initErrorForwarding } from "./error-forwarding";
import { Tracing } from "./tracing";

export const Trace = {
  // --- Console logging (live getters preserve devtools source lines) ---
  get info(): LogFunctionWithCategory {
    return Logger.info;
  },
  get warn(): LogFunctionWithCategory {
    return Logger.warn;
  },
  get err(): LogFunctionWithCategory {
    return Logger.err;
  },
  get dbg(): LogFunction {
    return Logger.dbg;
  },

  // --- Span tracing ---
  span: Tracing.span,
  event: Tracing.event,
  record: Tracing.record,
  log: Tracing.log,
  llm: Tracing.llm,
  setLevel: Tracing.setLevel,
  isActive: Tracing.isActive,
  getSessionId: Tracing.getSessionId,
  flush: Tracing.flush,
  onEntry: Tracing.onEntry,

  /**
   * Configure the trace sinks. Pass `sinks` (one or many destination URLs —
   * typically `Network.*`-codegenerated tento-web routes) so the package knows
   * where to upload without depending on any API client.
   */
  configure: Tracing.configure,

  // --- Console-as-sink + capture ---
  /** Route all `Logger` output through the tracing pipeline (console-as-sink). */
  captureConsole: captureConsoleIntoTracing,
  /** Forward unhandled errors + promise rejections into the trace stream. */
  initErrorForwarding,
};
