import PACKAGED_COPY from "./hosted-badge.switched.ts";

/**
 * A small pill above the landing's docs saying Autophys was built for Meta
 * Global Hacks. It is a packaging choice, not part of the source: the copy
 * lives in hosted-badge.switched.ts, which the build bundles only when
 * `AUTOPHYS_HOSTED_BADGE=on` (html/.env.example). A clone of the repository
 * builds without it, and the pill renders nowhere.
 */
export type HostedBadgeCopy = { readonly text: string; readonly href: string };

/** The pill for `copy` (the packaged copy by default), or null when the build left it out. */
export function hostedBadge(copy: HostedBadgeCopy | null = PACKAGED_COPY): HTMLElement | null {
  if (copy == null) return null;
  const row = document.createElement("div");
  row.className = "ap-hosted-badge";
  const pill = document.createElement("a");
  pill.className = "ap-hosted-badge-pill";
  pill.href = copy.href;
  pill.target = "_blank";
  pill.rel = "noopener noreferrer";
  pill.textContent = copy.text;
  row.append(pill);
  return row;
}

export const HOSTED_BADGE_CSS = `
/* Aligned with the docs' text: std-documentation pads its content 12px top
 * plus 32px 16px (24px 12px at 768px and below; tento-ui documentation.ts),
 * so the pill takes the same inset and pulls the docs up to leave 20px. */
.ap-hosted-badge { position: relative; z-index: 1; max-width: 800px; margin: 0 auto -24px; padding-inline: 16px; box-sizing: border-box; }
@media (max-width: 768px) { .ap-hosted-badge { margin-bottom: -16px; padding-inline: 12px; } }
.ap-hosted-badge-pill {
  display: inline-flex; align-items: center; height: 24px; padding: 0 10px;
  border: 1px solid var(--ck-line, #d9d9d9); border-radius: 999px;
  background: var(--ck-n100, #f7f7f7); color: var(--ck-secondary, #424242);
  font: 500 12px/16px var(--ck-font, system-ui, sans-serif); white-space: nowrap;
  text-decoration: none; transition: border-color 120ms ease, color 120ms ease;
}
.ap-hosted-badge-pill:hover { border-color: var(--ck-n600, #5c5c5c); color: var(--ck-ink, #141414); }
.ap-hosted-badge-pill:focus-visible { outline: 2px solid var(--ck-ink, #141414); outline-offset: 2px; }
`;
