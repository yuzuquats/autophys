// Human-scale formatting for machine metrics — the shared vocabulary of the
// meters family ("17.8", "1.7T", "21d 12h", "12s ago"). Pure string
// formatters, no DOM: usable from components and from the product wiring
// that builds their props.
export namespace Units {
  /** Gibibytes with one decimal and NO unit: "17.8" (compose with a sibling
   * total, e.g. "17.8/32.0G"). */
  export function gibibytes(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(1);
  }

  /** Compact size WITH a unit: "17.8G", "1.7T" — keeps value columns narrow. */
  export function compactBytes(bytes: number): string {
    const g = bytes / 1024 ** 3;
    return g >= 1024 ? `${(g / 1024).toFixed(1)}T` : `${g.toFixed(1)}G`;
  }

  /** A byte rate WITH a unit: "812K/s", "1.4M/s". Scales from bytes, unlike
   * compactBytes — network and disk rates are routinely kilobytes, and
   * compactBytes would render every one of them as "0.0G". */
  export function rate(bytesPerSec: number): string {
    const n = Math.max(0, bytesPerSec);
    if (n < 1024) return `${Math.round(n)}B/s`;
    if (n < 1024 ** 2) return `${Math.round(n / 1024)}K/s`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}M/s`;
    return `${(n / 1024 ** 3).toFixed(1)}G/s`;
  }

  /** Coarse duration from seconds: "21d 12h", "3h 12m", "42m". */
  export function duration(secs: number): string {
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  /** Age of a timestamp (anything Date can parse): "12s ago" under 90s, then
   * "5m ago"; echoes the input when unparsable. */
  export function age(ts: string): string {
    const ageMs = Date.now() - new Date(ts).getTime();
    if (!Number.isFinite(ageMs)) return ts;
    const secs = Math.max(0, Math.round(ageMs / 1000));
    if (secs < 90) return `${secs}s ago`;
    return `${Math.round(secs / 60)}m ago`;
  }
}
