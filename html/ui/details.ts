/// <reference lib="dom" />
/**
 * The details surface: a titled header and status line, sections of facts, tables, bars,
 * meters, fields and links, an optional decision row of exactly two buttons and an optional
 * row of other buttons. Fields report raw text; the caller validates it.
 */
import { emptyMarkup } from "./state-markup.ts";
import { barsMarkup } from "./charts.ts";
import { ICONS } from "./icons.ts";
import { ATTR, escapeHtml as esc, intentOf, type IntentHandler } from "./intent.ts";
import { buttonMarkup } from "./main.ts";
import type { Block, DetailsModel, Tag } from "./view-model.ts";

/** Class names (and the card-name attribute) the host page's own recipes expect. */
export type DetailsClasses = { name?: string; status?: string; decision?: string; button?: string; primary?: string; cardNameAttribute?: string };

const tag = (t?: Tag) => (t ? ` <span class="ap-tag ap-t-${t.tone ?? "default"}">${esc(t.text)}</span>` : "");
const tone = (t?: string) => (t ? ` ap-t-${t}` : "");

function blockMarkup(b: Block): string {
  switch (b.kind) {
    case "missing": return `<div class="ap-gap">${emptyMarkup(b.title, b.description)}</div>`;
    case "facts":
      return `<dl class="ap-facts">${b.rows.map((r) => `<div><dt>${esc(r.label)}</dt><dd class="${tone(r.tone).trim()}">${r.value ? `<span>${esc(r.value)}</span>` : ""}${r.note ? ` <span class="ap-note">${esc(r.note)}</span>` : ""}${tag(r.tag)}</dd></div>`).join("")}</dl>`;
    case "table":
      return `<table class="ap-table"><tbody>${b.rows.map((r) => `<tr${r.dim ? ` class="ap-dim"` : ""}>${r.cells.map((c) =>
        `<td${c.end ? ` class="ap-end"` : ""}>${c.text ? esc(c.text) : ""}${c.unit ? ` <span class="ap-unit">${esc(c.unit)}</span>` : ""}${tag(c.tag)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "bars":
      return barsMarkup(b.rows);
    case "meters":
      return `<div class="ap-meters">${b.rows.map((m) => `<div class="ap-meter"><div class="ap-meter-head"><span>${esc(m.label)}</span><b>${esc(m.value)}</b></div><div class="ap-meter-track"><i class="${tone(m.tone).trim()}" style="width:${(Math.max(0, Math.min(1, m.fraction)) * 100).toFixed(1)}%"></i></div></div>`).join("")}</div>`;
    case "fields":
      return `<div class="ap-fields">${b.fields.map((fl) => `<label class="ap-field${fl.invalid ? " ap-invalid" : ""}"><span class="ap-field-label">${esc(fl.label)}</span><span class="ap-input"><input type="text" inputmode="decimal" autocomplete="off" id="ap-field-${esc(fl.name)}" ${ATTR.role}="field" ${ATTR.name}="${esc(fl.name)}" value="${esc(fl.value)}"${fl.invalid ? ` aria-invalid="true"` : ""}>${fl.unit ? `<i>${esc(fl.unit)}</i>` : ""}</span>${fl.invalid ? `<small class="ap-field-error">${esc(fl.invalid)}</small>` : ""}</label>`).join("")}</div>`;
    case "links":
      return `<div class="ap-links">${b.links.map((l) => `<button type="button" class="ap-link" ${ATTR.role}="select" ${ATTR.id}="${esc(l.id)}">${esc(l.label)}</button>`).join("")}</div>`;
    case "text":
      return `<p class="ap-text${tone(b.tone)}">${esc(b.text)}${b.link ? ` <button type="button" class="ap-link" ${ATTR.role}="select" ${ATTR.id}="${esc(b.link.id)}">${esc(b.link.label)}</button>` : ""}</p>`;
  }
}

export function detailsMarkup(model: DetailsModel, classes: DetailsClasses = {}): string {
  const name = [classes.name ?? "", "ap-dname"].filter(Boolean).join(" ");
  const status = [classes.status ?? "", "ap-status", model.status.tone ? `ap-t-${model.status.tone}` : ""].filter(Boolean).join(" ");
  const card = model.cardName ? ` ${classes.cardNameAttribute ?? "data-card-name"}` : "";
  let out = `<h3 class="${esc(name)}"${card}>${ICONS[model.icon]}<span>${esc(model.title)}</span></h3><p class="${esc(status)}" id="ap-status" role="status">${esc(model.status.text)}</p>`;
  for (const s of model.sections) out += `<h4 class="ap-sub">${esc(s.heading)}</h4>${s.blocks.map(blockMarkup).join("")}`;
  if (model.decision) {
    const row = [classes.decision ?? "", "ap-decision"].filter(Boolean).join(" ");
    out += `<div class="${esc(row)}">${model.decision.map((a) => buttonMarkup(a, classes)).join("")}</div>`;
  }
  if (model.actions?.length) out += `<div class="ap-actions${model.actions.length === 1 ? " ap-one" : ""}">${model.actions.map((a) => buttonMarkup(a, classes)).join("")}</div>`;
  return out;
}

export class AutophysDetails {
  private abort = new AbortController();

  constructor(private host: HTMLElement, onIntent: IntentHandler, private classes: DetailsClasses = {}, private hydrate: (host: HTMLElement) => void = () => {}) {
    const { signal } = this.abort;
    host.addEventListener("click", (e) => {
      const el = (e.target as Element).closest?.<HTMLElement>(`[${ATTR.role}]`);
      const intent = el && host.contains(el) ? intentOf(el as HTMLButtonElement, "click") : null;
      if (intent) onIntent(intent);
    }, { signal });
    for (const type of ["input", "change"] as const) {
      host.addEventListener(type, (e) => {
        const intent = intentOf(e.target as HTMLInputElement, type);
        if (intent) onIntent(intent);
      }, { signal });
    }
    // Enter in a field commits it, as leaving it does.
    host.addEventListener("keydown", (e) => {
      const el = e.target as HTMLInputElement;
      if (e.key === "Enter" && el.getAttribute?.(ATTR.role) === "field") el.dispatchEvent(new Event("change", { bubbles: true }));
    }, { signal });
  }

  /** Redraws; a focused field keeps its focus and caret across the redraw. */
  render(model: DetailsModel): void {
    const root = this.host.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement as HTMLInputElement | null;
    const field = active && this.host.contains(active) && active.getAttribute(ATTR.role) === "field" ? active.getAttribute(ATTR.name) : null;
    const caret = field ? [active!.selectionStart, active!.selectionEnd] as const : null;
    this.host.innerHTML = detailsMarkup(model, this.classes);
    this.hydrate(this.host);
    if (!field) return;
    const next = this.host.querySelector<HTMLInputElement>(`[${ATTR.name}="${CSS.escape(field)}"]`);
    if (!next) return;
    next.focus({ preventScroll: true });
    if (caret) try { next.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
  }

  destroy(): void {
    this.abort.abort();
  }
}
