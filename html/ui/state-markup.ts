import { escapeHtml as esc } from "./intent.ts";
export function emptyMarkup(title: string, description: string): string {
  return `<div data-ap-empty data-title="${esc(title)}" data-description="${esc(description)}"><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
}
export const skeletonMarkup = () => `<div data-ap-skeleton aria-hidden="true"></div>`;
export function componentButton(name: string, label: string): string {
  return `<span data-ap-button="${esc(name)}"><button type="button">${esc(label)}</button></span>`;
}
export function recoveryMarkup(): string {
  return `<div class="ap-recovery">${componentButton("retry", "Retry connection")}<a href="?source=fixtures">View demo data</a></div>`;
}
