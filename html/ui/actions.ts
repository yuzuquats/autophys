import { escapeHtml as esc } from "./intent.ts";
import { actionAttrs } from "./sidebar-markup.ts";
import type { Action } from "./view-model.ts";

export function buttonMarkup(a: Action, classes: { button?: string; primary?: string }): string {
  const variant = a.variant ?? "secondary";
  const cls = [classes.button ?? "", variant === "primary" ? classes.primary ?? "" : "", "ap-btn", `ap-btn-${variant}`].filter(Boolean).join(" ");
  return `<button type="button" class="${esc(cls)}" ${actionAttrs(a)}>${esc(a.label)}</button>`;
}
