import { escapeHtml as esc } from "./intent.ts";
export function emptyMarkup(title: string, description: string): string {
  return `<div data-ap-empty data-title="${esc(title)}" data-description="${esc(description)}"><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
}
/** Placeholder blocks with a slow shimmer (placeholder-styles.ts): a list (sidebar, main) or a details pane. */
const PH = {
  list: [["b", 78], ["", 62], ["", 70], ["", 54], ["", 66]],
  details: [["t", 58], ["", 38], ["card", 100], ["", 82], ["", 64], ["", 74]],
} as const;
export const skeletonMarkup = (shape: keyof typeof PH = "list") =>
  `<div class="ap-ph ap-ph-${shape}" aria-hidden="true">${PH[shape].map(([k, w]: readonly [string, number]) => `<i class="${k}" style="--w:${w}%"></i>`).join("")}</div>`;
export function componentButton(name: string, label: string): string {
  return `<span data-ap-button="${esc(name)}"><button type="button">${esc(label)}</button></span>`;
}
export function recoveryMarkup(): string {
  return `<div class="ap-recovery">${componentButton("retry", "Retry connection")}</div>`;
}
