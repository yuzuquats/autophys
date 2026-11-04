/**
 * Compatibility shim — error/rejection forwarding moved to `@tento-trace`.
 * Re-exported so existing importers keep working; prefer `@tento-trace` in new code.
 */
export { initErrorForwarding } from "@tento-trace";
