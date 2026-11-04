import { PartialDate } from "@tento-chrono";
import { Tracing } from "@tento-core/tracing";

/**
 * Namespace for debug attributes that only apply when debugging is enabled.
 * Separates debug information from functional styling attributes.
 *
 * Debug attributes are prefixed with "debug-" to distinguish from
 * functional attributes like "data-span-mode" which affect CSS styling.
 */
export namespace DebugAttributes {
  const STORAGE_KEY = "lona-sheet-debug";

  /**
   * Whether debug attributes should be applied.
   * Can be toggled via localStorage for persistence across sessions.
   */
  export let enabled = (() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "true";
  })();

  /**
   * Enable or disable debug attributes.
   * Persists the setting to localStorage.
   */
  export function setEnabled(value: boolean): void {
    enabled = value;
    if (typeof localStorage !== "undefined") {
      if (value) {
        localStorage.setItem(STORAGE_KEY, "true");
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }

  /**
   * Information about a span for debugging purposes.
   */
  export interface SpanDebugInfo {
    ownedPd: Option<PartialDate>;
    spanCount: Option<number>;
    columnPd: PartialDate;
    columnOffset: number;
    startOffset: Option<number>;
    spanWidthPx: Option<number>;
    rowTimescale: string;
  }

  /**
   * Apply span debug attributes to a cell.
   * Only applies when debug mode is enabled.
   * Accepts HTMLElement to avoid circular dependency with SheetCell.
   */
  export function applySpanDebug(
    $cell: HTMLElement,
    info: SpanDebugInfo,
  ): void {
    if (!enabled) return;

    // Set all debug attributes with "debug-" prefix
    if (info.ownedPd != null) {
      $cell.setAttribute("debug-owned-pd", info.ownedPd.toString());
    }
    if (info.spanCount != null) {
      $cell.setAttribute("debug-span-count", String(info.spanCount));
    }
    $cell.setAttribute("debug-column-pd", info.columnPd.toString());
    $cell.setAttribute("debug-column-offset", String(info.columnOffset));
    if (info.startOffset != null) {
      $cell.setAttribute("debug-start-offset", String(info.startOffset));
    }
    if (info.spanWidthPx != null) {
      $cell.setAttribute("debug-span-width-px", String(info.spanWidthPx));
    }
    $cell.setAttribute("debug-row-timescale", info.rowTimescale);
  }

  /**
   * Clear all debug attributes from a cell.
   * Accepts HTMLElement to avoid circular dependency with SheetCell.
   */
  export function clearSpanDebug($cell: HTMLElement): void {
    $cell.removeAttribute("debug-owned-pd");
    $cell.removeAttribute("debug-span-count");
    $cell.removeAttribute("debug-column-pd");
    $cell.removeAttribute("debug-column-offset");
    $cell.removeAttribute("debug-start-offset");
    $cell.removeAttribute("debug-span-width-px");
    $cell.removeAttribute("debug-row-timescale");
    $cell.removeAttribute("debug-static-child");
  }

  /**
   * Mark a cell as being rendered via static child.
   * Accepts HTMLElement to avoid circular dependency with SheetCell.
   */
  export function markStaticChild($cell: HTMLElement, isStatic: boolean): void {
    if (!enabled) return;
    if (isStatic) {
      $cell.setAttribute("debug-static-child", "true");
    } else {
      $cell.removeAttribute("debug-static-child");
    }
  }

  /**
   * Log debug information when enabled.
   * Uses llm.log for consistency with existing logging.
   */
  export function trace(category: string, data: Record<string, unknown>): void {
    if (!enabled) return;
    Tracing.log(`debug/${category}`, data);
  }
}
