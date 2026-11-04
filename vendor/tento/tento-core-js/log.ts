/**
 * Compatibility shim — frontend logging moved onto the `Tracing` surface in
 * the dependency-free `@tento-trace` package. Re-exported here so existing
 * `@tento-core/log` importers keep working. Prefer `@tento-core/tracing`.
 */
export * from "@tento-trace/log";
