import { FeModeUtils } from "./fe-mode";

let initialized = false;

/**
 * On page load, persist any `?fe=…` query param into the sticky `fe-mode` cookie
 * so the unbundled (or bundled) choice survives later full reloads / deep URLs
 * without re-passing the param. Idempotent.
 */
export function initFeMode(): void {
  if (initialized) return;
  initialized = true;
  FeModeUtils.syncFromUrl();
}
