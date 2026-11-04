/**
 * `@tento-trace` — unified, DOM-free observability for the client.
 *
 * A single import surface over console logging (`Logger`) and span tracing
 * (`Tracing`). It has no dependency on DOM components, the API client, or any
 * higher tento package, so `lona-js` and every higher-level library can link it
 * without pulling in `@tento-ui`.
 *
 * Source-line preservation: `Logger` returns `console.log.bind(null, ...prefix)`
 * so devtools attributes each log to its true call site (see `./log`). The
 * UX-test session lifecycle + UI overlay remain in `@tento-ui/llm-logger`; only
 * this dependency-free core lives here.
 */
export * from "./log";
export * from "./tracing";

// Capture primitives (pure: no DOM components, no API client).
export * from "./rate-limiter";
export * from "./console-sink";
export * from "./error-forwarding";

// `Trace` — single-name convenience surface over Logger + Tracing.
export * from "./trace";
