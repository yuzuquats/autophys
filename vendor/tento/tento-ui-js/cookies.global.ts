import { Cookies } from "./cookies";

const INIT_FLAG = "__lona_cookies__";

export function initCookies(): void {
  if ((globalThis as any)[INIT_FLAG]) return;
  (globalThis as any)[INIT_FLAG] = true;

  (globalThis as any)["Cookies"] = Cookies;
}
