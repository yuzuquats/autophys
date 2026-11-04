import { DomUtils } from "./dom";

const INIT_FLAG = "__lona_dom_utils__";

export function initDomUtils(): void {
  if ((globalThis as any)[INIT_FLAG]) return;
  (globalThis as any)[INIT_FLAG] = true;

  (globalThis as any)["findOverflowParent"] = DomUtils.findOverflowParent;
}
