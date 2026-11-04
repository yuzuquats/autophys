export type FeMode = "bundled" | "unbundled";

import { Cookies } from "./cookies";

/**
 * Frontend delivery mode, orthogonal to {@link DevMode}'s stage axis. Selects
 * whether a route is served as the monolithic bundle (default) or the per-file
 * unbundled build (import map + content-hashed `/js/m/**` modules). The server
 * reads `?fe=unbundled` > cookie `fe-mode` > default `bundled`; this mirror keeps
 * the cookie in sync so the choice persists across full reloads / deep URLs.
 */
export class FeModeUtils {
  static feModeIdentifier = "fe-mode";

  static getMode(): FeMode {
    return (Cookies.get(FeModeUtils.feModeIdentifier) as FeMode) ?? "bundled";
  }

  static clear(domain?: Option<string>) {
    Cookies.remove(FeModeUtils.feModeIdentifier, domain);
  }

  static setMode(
    mode: FeMode,
    domain: Option<string> = ".lona.so",
    sameSite: Option<"None" | "Lax"> = "None",
  ) {
    Cookies.set(FeModeUtils.feModeIdentifier, {
      value: mode,
      domain,
      sameSite,
    });
    location.reload();
  }

  /**
   * Persist a `?fe=…` query param into the sticky `fe-mode` cookie so the choice
   * survives subsequent full reloads / deep URLs without re-passing the param.
   * Does NOT reload — the server already selected this load's build from the
   * param. A no-op when there is no (recognized) `fe` param.
   */
  static syncFromUrl(): void {
    const fe = new URLSearchParams(globalThis.location?.search ?? "").get("fe");
    if (fe !== "unbundled" && fe !== "bundled") return;
    if (FeModeUtils.getMode() === fe) return;
    Cookies.set(FeModeUtils.feModeIdentifier, {
      value: fe,
      domain: ".lona.so",
      sameSite: "None",
    });
  }
}
