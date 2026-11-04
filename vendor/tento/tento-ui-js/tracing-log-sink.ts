/**
 * Compatibility shim — the console→tracing bridge moved to `@tento-trace`.
 * Re-exported so existing importers keep working; prefer `@tento-trace` in new code.
 */
export { captureConsoleIntoTracing, tracingLogSink } from "@tento-trace";
