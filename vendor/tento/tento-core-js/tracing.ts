/**
 * Compatibility shim — tracing and frontend logging live in the
 * dependency-free `@tento-trace` package. Re-exported here so existing
 * `@tento-core/tracing` importers keep working.
 */
export * from "@tento-trace";
