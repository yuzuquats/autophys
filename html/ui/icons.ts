/** Lona-js icons are bound by the browser adapter; these markers stay DOM-free. */
import type { IconName } from "./view-model.ts";
const icon = (name: string) => `<span data-ap-icon="${name}" aria-hidden="true"></span>`;
export const ICONS: Record<IconName, string> = {
  workspace: icon("workspace"), device: icon("device"), config: icon("config"), investigation: icon("investigation"),
  measurements: icon("measurement"), measurement: icon("measurement"), fit: icon("fit"),
  sensitivity: icon("sensitivity"), proposal: icon("proposal"), validate: icon("validate"),
  view: icon("view"), residuals: icon("sensitivity"), landscape: icon("landscape"), envelope: icon("fit"),
  frequency: icon("sensitivity"), zoom: icon("zoom"), plus: icon("plus"), chevron: icon("chevron"),
};

/** A spinner that turns inside a shadow root too (SMIL, so it needs no stylesheet). */
export function spinnerSvg(size = 10): string {
  return `<svg class="ap-spin" width="${size}" height="${size}" viewBox="0 0 10 10" fill="none" aria-hidden="true"><circle cx="5" cy="5" r="3.8" stroke="var(--ap-run-track)" stroke-width="1.6"/><path d="M5 1.2a3.8 3.8 0 0 1 3.8 3.8" stroke="var(--ap-run)" stroke-width="1.6" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 5 5" to="360 5 5" dur="0.9s" repeatCount="indefinite"/></path></svg>`;
}
