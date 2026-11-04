/**
 * Forward unhandled errors + promise rejections into the trace stream.
 *
 * Pure capture: rate-limited via `LogRateLimiter`, emitted as `Tracing` spans.
 * No DOM components or API client — only the platform `globalThis` event
 * handlers. Moved here from `@tento-ui/llm-logger-errors` so any host can arm
 * error capture without the UX-test UI harness.
 */
import { LogRateLimiter } from "./rate-limiter";
import { Tracing } from "./tracing";

/**
 * Initialize error and exception forwarding to Tracing.
 * Captures unhandled errors and promise rejections for UX test debugging.
 *
 * Call this early in app initialization (after the trace session is armed).
 */
export function initErrorForwarding(): void {
  // Forward exceptions
  globalThis.addEventListener("error", (event) => {
    LogRateLimiter.withGuard(() => {
      const data = {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack?.slice(0, 500),
      };

      const fingerprint = LogRateLimiter.canLog("exception", data);
      if (!fingerprint) return;

      Tracing.span("exception", () => {
        Tracing.setLevel("error");
        for (const [k, v] of Object.entries(data)) {
          Tracing.record(k, v);
        }
        Tracing.record("fingerprint", fingerprint);
      });
    });
  });

  // Forward unhandled promise rejections
  globalThis.addEventListener("unhandledrejection", (event) => {
    LogRateLimiter.withGuard(() => {
      const reason = event.reason;
      const data = {
        message: reason?.message ?? String(reason),
        stack: reason?.stack?.slice(0, 500),
      };

      const fingerprint = LogRateLimiter.canLog("unhandled-rejection", data);
      if (!fingerprint) return;

      Tracing.span("unhandled-rejection", () => {
        Tracing.setLevel("error");
        for (const [k, v] of Object.entries(data)) {
          Tracing.record(k, v);
        }
        Tracing.record("fingerprint", fingerprint);
      });
    });
  });
}
