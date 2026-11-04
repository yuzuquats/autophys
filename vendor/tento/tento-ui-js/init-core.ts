import "@tento-ui/globals";

import { Tracing } from "@tento-core/tracing";
import { TypedApi } from "@tento-core/typed-api";

import { Cookies } from "./cookies";
import { initCookies } from "./cookies.global";
import { DebounceFallbackExecutor } from "./debounce-fallback-executor";
import { initAdminControls } from "./dev/admin-controls.global";
import { initDevMode } from "./dev-mode.global";
import { initDomUtils } from "./dom.global";
import { initFastdom } from "./fastdom.global";
import { initFeMode } from "./fe-mode.global";
import { initHtmlElement } from "./init/html-element.global";

type InitCoreGlobal = typeof globalThis & {
  __lona_init_core__: Option<boolean>;
};

export function getCookie(name: string): Option<string> {
  const nameq = name + "=";
  const decodedCookie = decodeURIComponent(document.cookie);
  const ca = decodedCookie.split(";");
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === " ") {
      c = c.substring(1);
    }
    if (c.indexOf(nameq) === 0) {
      return c.substring(nameq.length, c.length);
    }
  }
  return null;
}

export function initCore(): void {
  if (!claimInitCore()) return;

  initHtmlElement();
  initFastdom();
  initCookies();
  Tracing.install(false, Cookies.get("dev-mode") === "beta");
  // The no-service-worker executor (`DebounceFallbackExecutor`): answers
  // read by `DebouncedRequests.classify` (a followed redirect to the login
  // page is a refusal, never an acceptance), and every execution bounded by
  // a deadline so a hung fetch settles its durable write as unanswered.
  TypedApi.installStaticDebounce(DebounceFallbackExecutor.system());
  initDevMode();
  initFeMode();
  initAdminControls();
  initDomUtils();
}

function claimInitCore(): boolean {
  const state = globalThis as InitCoreGlobal;
  if (state.__lona_init_core__) return false;
  state.__lona_init_core__ = true;
  return true;
}

export { initCookies } from "./cookies.global";
export { initAdminControls } from "./dev/admin-controls.global";
export { initDevMode } from "./dev-mode.global";
export { initFeMode } from "./fe-mode.global";
export { initDomUtils } from "./dom.global";
export { initFastdom } from "./fastdom.global";
// Re-export init functions for cherry-picking.
export { initHtmlElement } from "./init/html-element.global";

initCore();
