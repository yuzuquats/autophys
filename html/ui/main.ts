/// <reference lib="dom" />
/**
 * The main surface: a crumb with a meta line and buttons, the viewer (panels of charts) and
 * one credit line. Charts are drawn at the host's width and redrawn when it changes.
 */
import { emptyMarkup, skeletonMarkup, componentButton, recoveryMarkup } from "./state-markup.ts";
import { chartMarkup } from "./charts.ts";
import { ATTR, escapeHtml as esc, intentOf, type IntentHandler } from "./intent.ts";
import { actionAttrs } from "./sidebar-markup.ts";
import type { Action, MainModel } from "./view-model.ts";

/** Class names the host page styles these elements with (its toolbar and button recipes). */
export type MainClasses = { toolbar?: string; button?: string; primary?: string };

export function buttonMarkup(a: Action, classes: { button?: string; primary?: string }): string {
  const variant = a.variant ?? "secondary";
  const cls = [classes.button ?? "", variant === "primary" ? classes.primary ?? "" : "", "ap-btn", `ap-btn-${variant}`].filter(Boolean).join(" ");
  return `<button type="button" class="${esc(cls)}" ${actionAttrs(a)}>${esc(a.label)}</button>`;
}

/** The whole main surface at `width` pixels. */
export function mainMarkup(model: MainModel, width: number, classes: MainClasses = {}): string {
  const sep = `<span class="ap-sep" aria-hidden="true">/</span>`;
  const crumb = model.crumb.map((c, i) => {
    const last = i === model.crumb.length - 1;
    if (last) return `<b>${esc(c.label)}</b>`;
    return c.id ? `<button type="button" ${ATTR.role}="select" ${ATTR.id}="${esc(c.id)}">${esc(c.label)}</button>` : `<span>${esc(c.label)}</span>`;
  }).join(sep);
  const toolbar = `<div class="${esc([classes.toolbar ?? "", "ap-toolbar"].filter(Boolean).join(" "))}"><nav class="ap-crumb" aria-label="Selection">${crumb}</nav><div class="ap-right"><span class="ap-meta" id="ap-meta">${esc(model.meta)}</span>${model.actions.map((a) => buttonMarkup(a, classes)).join("")}</div></div>`;
  let body: string;
  if (model.body.kind === "empty") {
    body = `<div class="ap-viewer ap-empty"><p>${esc(model.body.text)}</p></div>`;
  } else if (model.body.kind === "onboarding") {
    const b = model.body;
    body = `<section class="ap-viewer ap-onboarding"><h2>${esc(b.title)}</h2><p class="ap-intro">${esc(b.description)}</p><div class="ap-code-head"><b>Python SDK</b>${componentButton("copy-sdk", b.copyLabel)}</div><pre class="ap-code" tabindex="0" aria-label="Python SDK getting started example"><code>${esc(b.snippet)}</code></pre><p class="ap-help">${esc(b.note)}</p><p class="ap-demo-link"><a href="?source=fixtures">View demo data</a><span>Explore a recorded calibration</span></p></section>`;
  } else if (model.body.kind === "loading") {
    body = `<section class="ap-viewer ap-state" aria-busy="true" role="status">${emptyMarkup(model.body.title, model.body.description)}${skeletonMarkup()}</section>`;
  } else if (model.body.kind === "missing" || model.body.kind === "unavailable") {
    body = `<section class="ap-viewer ap-state">${emptyMarkup(model.body.title, model.body.description)}</section>`;
  } else {
    const cols = Math.max(1, model.body.columns ?? 1);
    const inner = Math.max(120, width - 24);
    const colWidth = Math.floor((inner - (cols - 1) * 12) / cols);
    const panels = model.body.panels.map((p, i) =>
      `<section class="ap-panel">${p.title ? `<h4 class="ap-panel-title">${esc(p.title)}</h4>` : ""}${p.charts.map((c, j) =>
        `<div class="ap-chart">${chartMarkup(c, colWidth, `${i}-${j}`)}</div>`).join("")}</section>`).join("");
    body = `<div class="ap-viewer" style="--ap-cols:${cols}">${panels}</div>`;
  }
  const source = model.source === "demo" ? `<div class="ap-source"><span>Demo data</span><a href="?source=daemon">Back to live data</a></div>` : "";
  const error = model.connectionError ? `<aside class="ap-connection" role="alert"><b>Connection unavailable</b><p>${esc(model.connectionError)}</p>${recoveryMarkup()}</aside>` : "";
  return `${toolbar}${source}${error}${body}<p class="ap-credit" id="ap-credit">${esc(model.credit)}</p>`;
}

export class AutophysMain {
  private abort = new AbortController();
  private model: MainModel | null = null;
  private width = 0;
  private observer: ResizeObserver | null = null;

  constructor(private host: HTMLElement, onIntent: IntentHandler, private classes: MainClasses = {}, private hydrate: (host: HTMLElement) => void = () => {}) {
    host.addEventListener("click", (e) => {
      const el = (e.target as Element).closest?.<HTMLElement>(`[${ATTR.role}]`);
      const intent = el && host.contains(el) ? intentOf(el as HTMLButtonElement, "click") : null;
      if (intent) onIntent(intent);
    }, { signal: this.abort.signal });
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => {
        const w = Math.round(this.host.clientWidth);
        if (this.model && Math.abs(w - this.width) > 2) this.render(this.model);
      });
      this.observer.observe(host);
    }
  }

  /**
   * Redraws. The three top-level elements (toolbar, viewer, credit) are kept and only their
   * contents and attributes change, so a shell that FLIPs the host's children can move them.
   */
  render(model: MainModel): void {
    this.model = model;
    this.width = Math.round(this.host.clientWidth) || 640;
    const next = document.createElement("template");
    next.innerHTML = mainMarkup(model, this.width, this.classes);
    const fresh = [...next.content.children] as HTMLElement[], kept = [...this.host.children] as HTMLElement[];
    if (kept.length !== fresh.length || kept.some((el, i) => el.tagName !== fresh[i].tagName)) {
      this.host.replaceChildren(...fresh);
      this.hydrate(this.host);
      return;
    }
    kept.forEach((el, i) => {
      for (const a of [...el.attributes]) if (!fresh[i].hasAttribute(a.name)) el.removeAttribute(a.name);
      for (const a of [...fresh[i].attributes]) el.setAttribute(a.name, a.value);
      el.innerHTML = fresh[i].innerHTML;
    });
    this.hydrate(this.host);
  }

  destroy(): void {
    this.abort.abort();
    this.observer?.disconnect();
    this.observer = null;
  }
}
