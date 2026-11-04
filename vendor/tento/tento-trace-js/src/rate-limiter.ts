import type { Option } from "./option";
/**
 * Rate limiter for log/trace capture — prevents infinite loops and spam.
 *
 * Pure: fingerprint dedup + per-type rate windows + a global error cap + a
 * recursion guard. No DOM, no API, no higher-package dependency. Moved here
 * from `@tento-ui/llm-logger` so error-forwarding and any capture path can use
 * it without pulling in the UX-test UI harness.
 *
 * Safeguards:
 * - Recursion guard to prevent logging during log emission
 * - Fingerprint-based deduplication (strips line numbers, normalizes IDs)
 * - Per-type rate limit to cap logs per type per 5-second window
 * - Global cap on error/exception logs per session
 * - Memory-bounded fingerprint storage with periodic cleanup
 */
export class LogRateLimiter {
  private static isEmitting = false;
  private static recentFingerprints = new Map<string, number>();
  private static typeCounters = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private static totalErrorCount = 0;

  static readonly DEDUP_WINDOW_MS = 60_000; // 1 minute (industry standard)
  static readonly RATE_WINDOW_MS = 5_000;
  static readonly MAX_PER_TYPE = 10;
  static readonly MAX_TOTAL_ERRORS = 100;
  static readonly MAX_FINGERPRINTS = 500; // Memory cap

  /**
   * Compute a stable fingerprint for deduplication.
   * Strips volatile data (line numbers, timestamps) to group similar errors.
   */
  static computeFingerprint(type: string, data: unknown): string {
    if (type === "exception" || type === "unhandled-rejection") {
      return LogRateLimiter.computeExceptionFingerprint(data);
    }
    if (type === "api-error" || type === "api-call") {
      return LogRateLimiter.computeApiFingerprint(data);
    }
    // Fallback for other types
    return `${type}:${JSON.stringify(data)}`;
  }

  private static computeExceptionFingerprint(data: unknown): string {
    const d = data as { message?: string; stack?: string; filename?: string };
    const parts: string[] = [];

    // Include message, but normalize common variable patterns
    if (d.message) {
      parts.push(LogRateLimiter.normalizeMessage(d.message));
    }

    // Include filename without line numbers
    if (d.filename) {
      parts.push(d.filename.replace(/:\d+:\d+$/, ""));
    }

    // Include top 3 normalized stack frames
    if (d.stack) {
      const frames = LogRateLimiter.normalizeStack(d.stack);
      parts.push(...frames.slice(0, 3));
    }

    return parts.join("|");
  }

  private static computeApiFingerprint(data: unknown): string {
    const d = data as { method?: string; path?: string; status?: number };
    // Normalize path by replacing numeric IDs
    const normalizedPath = d.path?.replace(/\/\d+/g, "/{id}") ?? "";
    return `${d.method}:${normalizedPath}:${d.status}`;
  }

  /**
   * Normalize error message by removing variable data.
   */
  private static normalizeMessage(message: string): string {
    return message
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "{uuid}",
      )
      .replace(/\b\d{10,}\b/g, "{id}") // Long numeric IDs
      .slice(0, 200);
  }

  /**
   * Normalize stack trace by stripping line/column numbers.
   */
  private static normalizeStack(stack: string): string[] {
    return stack
      .split("\n")
      .slice(1) // Skip "Error: message" line
      .map((line) => line.trim())
      .filter((line) => line.startsWith("at "))
      .map((line) => line.replace(/:\d+:\d+\)?$/, ")")); // Strip :line:col
  }

  /**
   * Check if a log entry should be allowed based on rate limiting rules.
   * Returns the fingerprint if allowed, undefined if rate-limited.
   */
  static canLog(type: string, data: unknown): Option<string> {
    // 1. Check recursion guard
    if (LogRateLimiter.isEmitting) return undefined;

    // 2. Check global cap for error types
    if (
      type.startsWith("error-") ||
      type === "exception" ||
      type === "unhandled-rejection"
    ) {
      if (LogRateLimiter.totalErrorCount >= LogRateLimiter.MAX_TOTAL_ERRORS)
        return undefined;
    }

    // 3. Compute fingerprint and check deduplication
    const fingerprint = LogRateLimiter.computeFingerprint(type, data);
    const now = Date.now();
    const lastSeen = LogRateLimiter.recentFingerprints.get(fingerprint);
    if (lastSeen && now - lastSeen < LogRateLimiter.DEDUP_WINDOW_MS)
      return undefined;

    // 4. Check per-type rate limit
    const counter = LogRateLimiter.typeCounters.get(type);
    if (counter) {
      if (now > counter.resetAt) {
        counter.count = 0;
        counter.resetAt = now + LogRateLimiter.RATE_WINDOW_MS;
      }
      if (counter.count >= LogRateLimiter.MAX_PER_TYPE) return undefined;
      counter.count++;
    } else {
      LogRateLimiter.typeCounters.set(type, {
        count: 1,
        resetAt: now + LogRateLimiter.RATE_WINDOW_MS,
      });
    }

    // Update tracking with cleanup
    LogRateLimiter.recentFingerprints.set(fingerprint, now);
    if (
      type.startsWith("error-") ||
      type === "exception" ||
      type === "unhandled-rejection"
    ) {
      LogRateLimiter.totalErrorCount++;
    }

    // Periodic cleanup when map gets large
    if (
      LogRateLimiter.recentFingerprints.size > LogRateLimiter.MAX_FINGERPRINTS
    ) {
      LogRateLimiter.cleanupExpired(now);
    }

    return fingerprint;
  }

  private static cleanupExpired(now: number): void {
    for (const [fp, timestamp] of LogRateLimiter.recentFingerprints) {
      if (now - timestamp > LogRateLimiter.DEDUP_WINDOW_MS) {
        LogRateLimiter.recentFingerprints.delete(fp);
      }
    }
  }

  /**
   * Execute a function with the recursion guard active.
   * Returns undefined if already emitting (to prevent infinite loops).
   */
  static withGuard<T>(fn: () => T): Option<T> {
    if (LogRateLimiter.isEmitting) return undefined;
    LogRateLimiter.isEmitting = true;
    try {
      return fn();
    } finally {
      LogRateLimiter.isEmitting = false;
    }
  }
}
