/**
 * The console → tracing bridge: a `LogSink` that re-emits `Logger` output as
 * `Tracing` spans/events, plus `captureConsoleIntoTracing()` to install it.
 *
 * This is the concrete expression of "console output is just a sink": with the
 * bridge installed, every `Logger` call is also captured into the trace stream
 * (and uploaded through `Tracing.configure`'s sinks), while the pure
 * `console.log.bind` path keeps devtools source lines intact.
 */
import { type LogEntry, Logger, type LogSink } from "./log";
import { Tracing } from "./tracing";

function formatArgs(args: any[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export const tracingLogSink: LogSink = (entry: LogEntry): void => {
  if (Tracing.isActive()) {
    // Inside an existing span: emit as an event
    Tracing.event(entry.level, formatArgs(entry.args), {
      category: entry.category,
      ...(entry.frame
        ? { "frame.count": entry.frame.count, "frame.phase": entry.frame.phase }
        : {}),
    });
  } else {
    // No active span: create a standalone span
    Tracing.span(`log/${entry.category ?? "?"}`, (span) => {
      span.setLevel(entry.level);
      span.record("message", formatArgs(entry.args));
      if (entry.frame) {
        span.record("frame.count", entry.frame.count);
        span.record("frame.phase", entry.frame.phase);
      }
    });
  }
};

/**
 * Route all `Logger` output through the tracing pipeline (console-as-sink).
 * Idempotent at the `Logger.addSink` layer; call once during app/test init.
 */
export function captureConsoleIntoTracing(): void {
  Logger.addSink(tracingLogSink);
}
