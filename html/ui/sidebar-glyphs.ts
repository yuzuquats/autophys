/** Compact structural marks, sharing the artifacts rail’s folder metaphor. */
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const DEVICE_GLYPH = svg('<rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M5.5 4V2.5M10.5 4V2.5M6 12v1.5M10 12v1.5"/>');
export const PROJECT_GLYPH = svg('<path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2h3L8 4h4.5A1.5 1.5 0 0 1 14 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5V5Z"/>');
