// Cross-domain operator/service-account hint. Backed by the `lona-svc` cookie
// (Domain=lona.so) the server sets at login, so it's readable on every page in the
// *.lona.so family — including payload-less pages (/dev/*) — and an operator can
// toggle it across the whole family for debugging. ADVISORY ONLY: never an authz
// input (real authz stays on the HttpOnly session); the cookie is client-readable
// and client-writable on purpose.

// The `lona-svc` cookie itself: read (cached per page load) + cross-domain write.
namespace ServiceAccountCookie {
  const NAME = "lona-svc";
  const DOMAIN = "lona.so";
  const TTL_SECONDS = 7 * 24 * 60 * 60;

  let cached: Option<boolean> = null;
  let loaded = false;

  export function read(): Option<boolean> {
    if (!loaded) {
      cached = parse();
      loaded = true;
    }
    return cached;
  }

  // Writes the cookie scoped to the whole family so the override persists across
  // *.lona.so, and refreshes the per-page cache.
  export function write(value: boolean): void {
    document.cookie =
      `${NAME}=${value ? "1" : "0"}; Domain=${DOMAIN}; Path=/; ` +
      `Max-Age=${TTL_SECONDS}; SameSite=Lax; Secure`;
    cached = value;
    loaded = true;
  }

  function parse(): Option<boolean> {
    const prefix = NAME + "=";
    for (const part of document.cookie.split(";")) {
      const entry = part.trim();
      if (entry.startsWith(prefix)) {
        const raw = entry.slice(prefix.length);
        return raw === "1" || raw === "true";
      }
    }
    return null;
  }
}

export class Globals {
  static IS_SERVICE_ACCOUNT = "isServiceAccount";
  static TOAST_DURATION_MS = 4_000;
  static AUTO_REVEAL_ADMIN_LOG = false;

  // Legacy in-memory setter (the calendar payload bootstrap). The `lona-svc` cookie
  // takes precedence in the getter when present, so a cross-domain toggle wins.
  static set isServiceAccount(b: boolean) {
    window[Globals.IS_SERVICE_ACCOUNT] = b;
  }

  static get isServiceAccount(): boolean {
    const cookie = ServiceAccountCookie.read();
    if (cookie != null) return cookie;
    return window[Globals.IS_SERVICE_ACCOUNT] === true;
  }

  // Cross-domain debug toggle: persists the override across the whole family and
  // mirrors it for the current page. Operator-gated UI is usually re-bound by a
  // reload after calling this.
  static setServiceAccount(isServiceAccount: boolean): void {
    ServiceAccountCookie.write(isServiceAccount);
    window[Globals.IS_SERVICE_ACCOUNT] = isServiceAccount;
  }
}
