/** Lona shares sessions across its subdomains; other products keep them local. */
export function uxSessionCookieDomain(hostname: string): string {
  return hostname === "lona.so" || hostname.endsWith(".lona.so") ? ".lona.so" : "";
}
