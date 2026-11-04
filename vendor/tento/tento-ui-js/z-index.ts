// biome-ignore-all format: align #s

export namespace ZIndex {
  export const FLOATING_PANEL  = 1000;  // mini-windows, chart crosshairs
  export const SIDEBAR         = 2000;  // sidebar strips, action bars
  export const STICKY          = 3000;  // fixed scroll children, sticky headers
  export const DRAWER          = 3500;  // drawer
  export const POPOVER         = 4000;  // dropdowns, context menus, anchor content
  export const TOOLTIP         = 5000;  // tracking tooltips
  export const OVERLAY         = 6000;  // modal backdrop
  export const OVERLAY_CONTENT = 6001;  // modal content (overlay + 1)
  export const TOAST           = 7000;  // toast notifications (above overlays)
  export const BLOCKING        = 8000;  // safari-block, full-screen errors
  export const DRAG_GHOST      = 9000;  // reorder drag ghost
  export const DEV_TOOLS       = 9500;  // llm-logger, admin-controls
  export const DEBUG           = 9999;  // debug-panel (absolute top)

  const popoverStack: number[] = [POPOVER];

  export function pushPopoverLevel(z: number): void {
    popoverStack.push(z);
  }

  export function popPopoverLevel(): void {
    if (popoverStack.length > 1) popoverStack.pop();
  }

  export function popoverLevel(): number {
    return popoverStack[popoverStack.length - 1];
  }
}
