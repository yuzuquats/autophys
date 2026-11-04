import { DevModeUtils } from "./dev-mode";
import { Tracing } from "@tento-core/tracing";

const INIT_FLAG = "__lona_devmode__";

export function initDevMode(): void {
  if ((globalThis as any)[INIT_FLAG]) return;
  (globalThis as any)[INIT_FLAG] = true;

  DevModeUtils.emitUpdate();

  globalThis.addEventListener("setDevMode", ((e: CustomEvent) => {
    Tracing.dev(`[DevTools] setting mode to "${e.detail}"`);
    const mode = e.detail;
    DevModeUtils.setMode(mode);
  }) as EventListener);

  (globalThis as any)["devmode"] = DevModeUtils;
  (globalThis as any)["lonajs"] = () => DevModeUtils.setMode("beta");
}
