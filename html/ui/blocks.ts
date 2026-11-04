import { emptyMarkup } from "./state-markup.ts";
import { barsMarkup } from "./charts.ts";
import { ATTR, escapeHtml as esc } from "./intent.ts";
import { buttonMarkup } from "./actions.ts";
import type { Block, Tag } from "./view-model.ts";

const tag = (t?: Tag) => (t ? ` <span class="ap-tag ap-t-${t.tone ?? "default"}">${esc(t.text)}</span>` : "");
const tone = (t?: string) => (t ? ` ap-t-${t}` : "");

export function blockMarkup(b: Block): string {
  switch (b.kind) {
    case "pairing": return `<article class="ap-pairing" aria-label="Pair ${esc(b.device)}"><h5>${esc(b.device)}</h5><p class="ap-pair-client">${esc(b.client)}</p><code class="ap-pair-code">${esc(b.code)}</code><time class="ap-pair-expiry" datetime="${esc(b.expiry.at)}" title="${esc(b.expiry.at)}" data-ap-timeline="${esc(JSON.stringify(b.expiry.steps))}">${esc(b.expiry.steps[0]?.label ?? "")}</time><p class="ap-help">Compare this code with the SDK terminal before approving.</p><div class="ap-pair-actions">${b.decision.map((a) => `<span data-ap-action="${a.variant ?? "secondary"}">${buttonMarkup(a, {})}</span>`).join("")}</div></article>`;
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
