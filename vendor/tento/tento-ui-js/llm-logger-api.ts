import { TypedApi } from "@tento-core/typed-api";
import { Network } from "./llm-logger-routes";

export type LlmSession = Network.Session;

export namespace LlmLoggerApi {
  let api: Option<TypedApi<Network.Routes>>;
  let baseUrl: Option<string>;

  export function init() {
    // Use saved origin so log POSTs survive cross-domain redirects
    // (e.g. Stripe portal redirects to production instead of dev)
    const savedOrigin = document.cookie
      .split("; ")
      .find((c) => c.startsWith("ux-test-origin="))
      ?.split("=")[1] ?? "";
    const isSameOrigin = savedOrigin === "" || savedOrigin === window.location.origin;
    baseUrl = isSameOrigin ? "" : savedOrigin;
    api = new TypedApi<Network.Routes>(
      Network.REVIVERS, null, null, isSameOrigin ? "same-origin" : "include",
      null, null, false,
    );
  }

  export function getApi(): Option<TypedApi<Network.Routes>> {
    return api;
  }

  export function getBaseUrl(): Option<string> {
    return baseUrl;
  }

  let tokenPromise: Option<Promise<void>>;

  /**
   * Mint the ux-test harness cookie (`lona-uxtest`, `Domain=.lona.so`) once per
   * page load. `POST /_/ux-test/token` requires a logged-in lona user (401 for
   * anon); on a logged-in surface it `Set-Cookie`s the HMAC token the
   * `/_/ux-test/*` routes now require (HarnessTokenGuard). Best-effort +
   * memoized: on anonymous pages the mint 401s harmlessly and the cookie minted
   * at the earlier logged-in launch (12h, `.lona.so`) is still carried through
   * the anon flow. Await this before any guarded `/_/ux-test` call so a first
   * logged-in load sets the cookie before it is used.
   */
  export function ensureToken(): Promise<void> {
    if (!tokenPromise) {
      const url = `${baseUrl ?? ""}/_/ux-test/token`;
      tokenPromise = fetch(url, {
        method: "POST",
        credentials: baseUrl ? "include" : "same-origin",
      })
        .then(() => undefined)
        .catch(() => undefined);
    }
    return tokenPromise;
  }
}
