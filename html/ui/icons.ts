/** Row and heading glyphs: 14-unit stroked marks in currentColor (after the ModelLab mocks). */
import type { IconName } from "./view-model.ts";

const svg = (body: string, width = 1.4) =>
  `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS: Record<IconName, string> = {
  workspace: svg(`<rect x="1.5" y="2" width="11" height="10" rx="2"/><line x1="5.5" y1="2" x2="5.5" y2="12"/>`),
  config: svg(`<path d="M2 4h6M10 4h2M2 10h2M6 10h6"/><circle cx="9" cy="4" r="1.3"/><circle cx="5" cy="10" r="1.3"/>`),
  investigation: svg(`<path d="M5 1.5h4M5.8 1.5v4L2.5 11.3a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L8.2 5.5v-4"/>`),
  measurements: svg(`<rect x="2" y="2" width="10" height="10" rx="1.5"/><line x1="2" y1="5.5" x2="12" y2="5.5"/><line x1="6" y1="5.5" x2="6" y2="12"/>`),
  measurement: svg(`<rect x="2" y="2" width="10" height="10" rx="1.5"/><line x1="2" y1="5.5" x2="12" y2="5.5"/><line x1="6" y1="5.5" x2="6" y2="12"/>`),
  fit: svg(`<path d="M1.5 9c2-6 3.5-6 5 0s3 6 5.5-4"/>`),
  sensitivity: svg(`<line x1="3" y1="12" x2="3" y2="5"/><line x1="7" y1="12" x2="7" y2="2"/><line x1="11" y1="12" x2="11" y2="10"/>`),
  proposal: svg(`<path d="M1.5 7c1.2-4 2.3-4 3.5 0s2.3 4 3.5 0 2.3-4 3.5 0"/>`),
  validate: svg(`<path d="M2.5 7.5 5.5 10.5 11.5 3.5"/>`),
  view: svg(`<path d="M2 11.5 5.5 7l2.5 2.5L12 3.5"/>`),
  residuals: svg(`<line x1="2" y1="7" x2="12" y2="7"/><circle cx="4" cy="5" r=".6"/><circle cx="6.5" cy="9" r=".6"/><circle cx="9" cy="6" r=".6"/><circle cx="11" cy="8.5" r=".6"/>`),
  landscape: svg(`<rect x="2" y="2" width="10" height="10" rx="1.5"/><path d="M2 10 10 2" stroke-dasharray="1.5 1.5"/>`),
  envelope: svg(`<path d="M1.5 3c3 0 5 3 10.5 4M1.5 11c3 0 5-3 10.5-4"/>`),
  frequency: svg(`<path d="M1.5 11.5C4 11.5 5 3 7 3s3 8.5 5.5 8.5"/>`),
  zoom: svg(`<circle cx="6" cy="6" r="3.8"/><path d="M8.8 8.8 12.5 12.5"/>`),
  plus: svg(`<path d="M7 2.5v9M2.5 7h9"/>`, 1.6),
  chevron: svg(`<polyline points="5 3.5 8.5 7 5 10.5"/>`, 1.6),
};

/** A spinner that turns inside a shadow root too (SMIL, so it needs no stylesheet). */
export function spinnerSvg(size = 10): string {
  return `<svg class="ap-spin" width="${size}" height="${size}" viewBox="0 0 10 10" fill="none" aria-hidden="true"><circle cx="5" cy="5" r="3.8" stroke="var(--ap-run-track)" stroke-width="1.6"/><path d="M5 1.2a3.8 3.8 0 0 1 3.8 3.8" stroke="var(--ap-run)" stroke-width="1.6" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 5 5" to="360 5 5" dur="0.9s" repeatCount="indefinite"/></path></svg>`;
}
