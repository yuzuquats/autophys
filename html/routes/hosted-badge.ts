/**
 * A small pill above the landing's docs saying Autophys was built for Meta
 * Global Hacks. It is shown only where Lona hosts the public site
 * (autophys.lona.so and its dev-- preview), never in a clone of the
 * repository or on a local daemon, which serve the same bundle from other
 * hosts.
 */
export const HOSTED_BADGE_TEXT = "Built for Meta Global Hacks";

/** Whether `hostname` is Lona's public Autophys site or its dev-- preview. */
export function isLonaHosted(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "autophys.lona.so" || host === "dev--autophys.lona.so";
}

/** The pill for `hostname`, or null off the hosted site. */
export function hostedBadge(hostname: string): HTMLElement | null {
  if (!isLonaHosted(hostname)) return null;
  const row = document.createElement("div");
  row.className = "ap-hosted-badge";
  const pill = document.createElement("span");
  pill.className = "ap-hosted-badge-pill";
  pill.textContent = HOSTED_BADGE_TEXT;
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
}
`;
