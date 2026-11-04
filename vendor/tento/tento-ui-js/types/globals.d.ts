import type { Fastdom } from "../fastdom";
import type { LogFunction } from "@tento-core/tracing";
import type { Cookies as CookiesType } from "../cookies";
import type { DevModeUtils } from "../dev-mode";
import type { AdminControls as AdminControlsType } from "../dev/admin-controls";
import type { DomUtils } from "../dom";

declare global {
  // Logging
  var dbg: LogFunction;
  var dev: LogFunction;
  var toggleLogging: (enabled: boolean) => void;
  var isLoggingEnabled: () => boolean;

  // Fastdom
  var $$: Fastdom;

  // Dev mode
  var devmode: typeof DevModeUtils;
  var lonajs: () => void;

  // Cookies
  var Cookies: typeof CookiesType;

  // Admin controls
  var AdminControls: typeof AdminControlsType;

  // DOM utils
  var findOverflowParent: typeof DomUtils.findOverflowParent;
}

export {};
