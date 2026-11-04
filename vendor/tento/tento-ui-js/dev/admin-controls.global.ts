import { AdminControls } from "./admin-controls";

const INIT_FLAG = "__lona_admin_controls__";

export function initAdminControls(): void {
  if ((globalThis as any)[INIT_FLAG]) return;
  (globalThis as any)[INIT_FLAG] = true;

  (globalThis as any)["AdminControls"] = AdminControls;
}
