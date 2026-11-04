import { Tracing } from "@tento-core/tracing";

import { Cookies } from "./cookies";
import { initCore } from "./init-core";
import { LLMLogger } from "./llm-logger";
import "./llm-logger-ui";
import { LlmLoggerApi } from "./llm-logger-api";

type InitGlobal = typeof globalThis & {
  __lona_init__: Option<boolean>;
};

export function init(): void {
  initCore();
  if (!claimInit()) return;

  if (shouldEnableLlmLogger()) {
    LlmLoggerApi.init();
    LLMLogger.bootstrap();

    // Configure tracing with session ID from URL or cookie
    const tid =
      new URLSearchParams(window.location.search).get("tid") ??
      Cookies.get("ux-tracing-id") ??
      undefined;
    Tracing.configure({ uploadUrl: "/api/tracing/entries", sessionId: tid });

    void LLMLogger.initFromUrlParam();
  }
}

function claimInit(): boolean {
  const state = globalThis as InitGlobal;
  if (state.__lona_init__) return false;
  state.__lona_init__ = true;
  return true;
}

function shouldEnableLlmLogger(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("ux") != null) return true;

  if (Cookies.get("lona-llm-logger") === "1") return true;
  if (Cookies.get("ux-test-session")) return true;

  try {
    return localStorage.getItem("lona:llm-logger") === "1";
  } catch {
    return false;
  }
}

export {
  getCookie,
  initAdminControls,
  initCookies,
  initDevMode,
  initDomUtils,
  initFastdom,
  initFeMode,
  initHtmlElement,
} from "./init-core";

init();
