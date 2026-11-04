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
      return `<table class="ap-table"><tbody>${b.rows.map((r) => `<tr${r.dim ? ` class="ap-dim"` : r.strong ? ` class="ap-strong"` : ""}>${r.cells.map((c) =>
        `<td${c.end ? ` class="ap-end"` : ""}>${c.text ? esc(c.text) : ""}${c.unit ? ` <span class="ap-unit">${esc(c.unit)}</span>` : ""}${tag(c.tag)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "bars":
      return barsMarkup(b.rows);
    case "meters":
      return `<div class="ap-meters">${b.rows.map((m) => `<div class="ap-meter"><div class="ap-meter-head"><span>${esc(m.label)}</span><b>${esc(m.value)}</b></div><div class="ap-meter-track"><i class="${tone(m.tone).trim()}" style="width:${(Math.max(0, Math.min(1, m.fraction)) * 100).toFixed(1)}%"></i></div></div>`).join("")}</div>`;
    case "fields":
      return `<div class="ap-fields">${b.fields.map((fl) => `<label class="ap-field${fl.invalid ? " ap-invalid" : ""}"><span class="ap-field-label">${esc(fl.label)}</span><span class="ap-input"><input type="text" inputmode="decimal" autocomplete="off" id="ap-field-${esc(fl.name)}" ${ATTR.role}="field" ${ATTR.name}="${esc(fl.name)}" value="${esc(fl.value)}"${fl.invalid ? ` aria-invalid="true"` : ""}>${fl.unit ? `<i>${esc(fl.unit)}</i>` : ""}</span>${fl.invalid ? `<small class="ap-field-error">${esc(fl.invalid)}</small>` : ""}</label>`).join("")}</div>`;
    case "links":
      return `<div class="ap-links">${b.links.map((l) => `<button type="button" class="ap-link" ${ATTR.role}="select" ${ATTR.id}="${esc(l.id)}">${esc(l.label)}</button>`).join("")}</div>`;
    case "wave":
      return waveMarkup(b.t, b.y, b.label, b.caption);
    case "trace":
      return `<ol class="ap-trace">${b.steps.map((s) => `<li class="${s.current ? "ap-cur" : ""}${s.tone ? ` ap-t-${s.tone}` : ""}"><div class="ap-trace-head"><b>${esc(s.title)}</b>${s.meta ? `<span>${esc(s.meta)}</span>` : ""}</div>${s.text ? `<p>${esc(s.text)}</p>` : ""}${s.evidence?.length ? `<ul>${s.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}${s.expected ? `<p class="ap-trace-exp">Expected: <b>${esc(s.expected)}</b></p>` : ""}</li>`).join("")}</ol>`;
    case "text":
      return `<p class="ap-text${tone(b.tone)}">${esc(b.text)}${b.link ? ` <button type="button" class="ap-link" ${ATTR.role}="select" ${ATTR.id}="${esc(b.link.id)}">${esc(b.link.label)}</button>` : ""}</p>`;
  }
}

/** A 0–1 normalised polyline in a fixed 100×24 viewBox, stretched to the card's width. A flat trace sits mid-height. */
function waveMarkup(t: number[], y: number[], label: string, caption?: string): string {
  const ok = t.map((x, i) => [x, y[i]]).filter(([x, v]) => Number.isFinite(x) && Number.isFinite(v));
  if (ok.length < 2) return "";
  const t0 = ok[0][0], t1 = ok[ok.length - 1][0], lo = Math.min(0, ...ok.map((p) => p[1])), hi = Math.max(0, ...ok.map((p) => p[1]));
  const sx = (x: number) => (t1 > t0 ? (x - t0) / (t1 - t0) : 0) * 100, sy = (v: number) => hi > lo ? 22 - (v - lo) / (hi - lo) * 20 : 12;
  const pts = ok.map(([x, v]) => `${sx(x).toFixed(2)},${sy(v).toFixed(2)}`).join(" ");
  return `<figure class="ap-wave" title="${esc(label)}">${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}<svg viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><line x1="0" x2="100" y1="${sy(0).toFixed(2)}" y2="${sy(0).toFixed(2)}"/><polyline points="${pts}"/></svg></figure>`;
}
