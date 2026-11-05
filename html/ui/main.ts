/// <reference lib="dom" />
/**
 * The main surface: a crumb with a meta line and buttons, the viewer (panels of charts) and
 * one credit line. Charts are drawn at the host's width and redrawn when it changes.
 */
import { emptyMarkup, skeletonMarkup, componentButton, recoveryMarkup } from "./state-markup.ts";
import { chartMarkup } from "./charts.ts";
import { ATTR, escapeHtml as esc, intentOf, type IntentHandler } from "./intent.ts";
import { buttonMarkup } from "./actions.ts";
import { newProjectFocusTarget, newProjectMarkup } from "./new-project.ts";
import { blockMarkup } from "./blocks.ts";
import { breadcrumbText } from "./breadcrumb.ts";
import type { ChartPanel, InvestigationBody, InvestigationCard, MainModel, Section } from "./view-model.ts";

/** Class names the host page styles these elements with (its toolbar and button recipes). */
export type MainClasses = { toolbar?: string; button?: string; primary?: string };

export { buttonMarkup } from "./actions.ts";

/** The whole main surface at `width` pixels. */
/** A card: a std-round surface, a list-cell header (title, caption under it) and its content. */
const cardMarkup = (cls: string, title: string, caption: string, inner: string) =>
  `<section class="ap-card ${cls}"><std-round floating bg="var(--ap-card-bg)" border="var(--ap-line)" radius="10"></std-round><header class="ap-card-head" data-ap-cell><h3>${esc(title)}</h3>${caption ? `<p>${esc(caption)}</p>` : ""}</header>${inner}</section>`;

export function mainMarkup(model: MainModel, width: number, classes: MainClasses = {}): string {
  const sep = `<span class="ap-sep" aria-hidden="true"> / </span>`;
  const crumb = model.crumb.map((c, i) => {
    const last = i === model.crumb.length - 1;
    if (last) return `<b title="${esc(c.label)}" aria-current="page">${esc(c.label)}</b>`;
    return c.id ? `<button type="button" title="${esc(c.label)}" ${ATTR.role}="select" ${ATTR.id}="${esc(c.id)}">${esc(c.label)}</button>` : `<span title="${esc(c.label)}">${esc(c.label)}</span>`;
  }).join(sep);
  const toolbar = `<div class="${esc([classes.toolbar ?? "", "ap-toolbar"].filter(Boolean).join(" "))}"><nav class="ap-crumb" aria-label="Selection" title="${esc(breadcrumbText(model.crumb))}">${crumb}</nav><div class="ap-right"><span class="ap-meta" id="ap-meta">${esc(model.meta)}</span>${model.actions.map((a) => buttonMarkup(a, classes)).join("")}</div></div>`;
  let body: string;
  if (model.body.kind === "project-setup") {
    body = newProjectMarkup(model.body);
  } else if (model.body.kind === "empty") {
    body = `<div class="ap-viewer ap-empty"><p>${esc(model.body.text)}</p></div>`;
  } else if (model.body.kind === "onboarding") {
    const b = model.body;
    body = `<section class="ap-viewer ap-onboarding"><h2>${esc(b.title)}</h2><p class="ap-intro">${esc(b.description)}</p><div class="ap-code-head"><b>Python SDK</b>${componentButton("copy-sdk", b.copyLabel)}</div><pre class="ap-code" tabindex="0" aria-label="Python SDK getting started example"><code>${esc(b.snippet)}</code></pre><p class="ap-help">${esc(b.note)}</p><p class="ap-demo-link"><a href="?source=fixtures">View demo data</a><span>Explore a recorded calibration</span></p></section>`;
  } else if (model.body.kind === "loading") {
    body = `<section class="ap-viewer ap-state" aria-busy="true" role="status">${emptyMarkup(model.body.title, model.body.description)}${skeletonMarkup()}</section>`;
  } else if (model.body.kind === "signed-out") {
    // `serve --login`, signed out: the pane is the sign-in card (the same form as /login).
    body = `<section class="ap-viewer ap-signin-wrap"><form class="ap-signin" method="post" action="/api/auth/login"><std-round floating bg="#fff" radius="14" shadow="0 10px 30px rgba(0,0,0,0.10)"></std-round><h2>${esc(model.body.title)}</h2><p>${esc(model.body.description)}</p><input type="hidden" name="next" value="/app"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button>${model.body.demo ? `<button type="submit" class="ap-signin-demo" formaction="/api/auth/demo" formnovalidate>Continue as demo</button>` : ""}</form></section>`;
  } else if (model.body.kind === "missing" || model.body.kind === "unavailable") {
    body = `<section class="ap-viewer ap-state">${emptyMarkup(model.body.title, model.body.description)}</section>`;
  } else if (model.body.kind === "investigation") {
    body = investigationMarkup(model.body, width);
  } else if (model.body.kind === "decision") {
    body = `<div class="ap-viewer ap-decision-view">${model.body.cards.map((s) => cardMarkup("ap-dcard", s.heading, s.caption ?? "", s.blocks.map(blockMarkup).join(""))).join("")}</div>`;
  } else if (model.body.kind === "configuration") {
    // Each card's header is a list cell: the title with its caption under it (hydrated to std-list-cell-layout).
    const card = cardMarkup;
    const section = (cls: string) => (s: Section) => card(cls, s.heading, s.caption ?? "", s.blocks.map(blockMarkup).join(""));
    // A scale or tag every parameter shares moves to the caption instead of repeating on each row.
    const rows = model.body.parameters.rows, shared = <T,>(f: (r: typeof rows[number]) => T) => rows.length > 0 && rows.every((r) => f(r) === f(rows[0])) ? f(rows[0]) : undefined;
    const scale = shared((r) => r.scale), tag = shared((r) => r.tag?.text);
    const parameters = { ...model.body.parameters, rows: rows.map((r) => ({ ...r, scale: scale ? undefined : r.scale, tag: tag ? undefined : r.tag })) };
    const params = card("ap-config-params", "Parameters", ["Bounds and initial guess", scale, tag && `all ${tag}`].filter(Boolean).join(" · "), chartMarkup(parameters, width - 48, "config"));
    const cards = [params, ...model.body.experiments.map(section("ap-config-exp")), ...model.body.sections.map(section("ap-config-limits"))];
    body = `<div class="ap-viewer ap-configuration"><div data-ap-grid="260">${cards.join("")}</div></div>`;
  } else {
    const cols = Math.max(1, model.body.columns ?? 1);
    const inner = Math.max(120, width - 24);
    const colWidth = Math.floor((inner - (cols - 1) * 12) / cols);
    const panels = model.body.panels.map((p, i) =>
      `<section class="ap-panel">${p.title ? `<h4 class="ap-panel-title">${esc(p.title)}</h4>` : ""}${p.charts.map((c, j) =>
        `<div class="ap-chart">${chartMarkup(c, colWidth, `${i}-${j}`)}</div>`).join("")}${(p.blocks ?? []).map(blockMarkup).join("")}</section>`).join("");
    body = `<div class="ap-viewer" style="--ap-cols:${cols}">${panels}</div>`;
  }
  const error = model.connectionError ? `<aside class="ap-connection" role="status"><b>Connection unavailable</b><p>${esc(model.connectionError)}</p>${recoveryMarkup()}</aside>` : "";
  if (model.body.kind === "investigation") return `${toolbar}${error}${body}`;
  return `${toolbar}${error}${body}<div class="ap-credit" id="ap-credit">${model.creditLabel ? `<details><summary>${esc(model.creditLabel)}</summary><p>${esc(model.credit)}</p><span data-ap-copy="${esc(model.credit)}"><button type="button">Copy provenance</button></span></details>` : esc(model.credit)}</div>`;
}


/** Reuse the same card, chart and block renderers as the decision and configuration views. */
function investigationMarkup(body: InvestigationBody, width: number): string {
  const wide = width >= 760, inner = Math.max(160, width - 64);
  const left = wide ? Math.floor((inner - 10) * .55) : inner;
  const right = wide ? inner - left - 10 : inner;
  const panels = (items: ChartPanel[], w: number, key: string) => items.map((p, i) =>
    `<section class="ap-panel">${p.title ? `<h4 class="ap-panel-title">${esc(p.title)}</h4>` : ""}${p.charts.map((c, j) =>
      `<div class="ap-chart">${chartMarkup(c, w, key + "-" + i + "-" + j)}</div>`).join("")}${(p.blocks ?? []).map(blockMarkup).join("")}</section>`).join("");
  const card = (c: InvestigationCard, w = inner) => {
    const rows = (c.rows ?? []).map(r => `<details class="ap-measurement" id="${esc(r.id)}" data-ap-disclosure${r.open ? " open" : ""}><summary><b>${esc(r.label)}</b><span>${esc(r.meta)}</span></summary><div class="ap-measurement-plot">${panels(r.panels, w, r.id)}</div></details>`).join("");
    return cardMarkup("ap-investigation-card", c.heading, c.caption ?? "",
      c.blocks.map(blockMarkup).join("") + panels(c.panels ?? [], w, c.id) + rows)
      .replace('<section class=', `<section id="${esc(c.id)}" tabindex="-1" class=`);
  };
  const jumps = `<nav class="ap-jumps" aria-label="Jump to investigation section">${body.jumps.map((j, i) =>
    `<button type="button" data-ap-jump="${esc(j.target)}"${i === 0 ? ' aria-current="location"' : ""}>${esc(j.label)}</button>`).join("")}</nav>`;
  const outcomeWidth = wide && body.outcome.length > 1 ? Math.floor((inner - 10) / 2) : inner;
  const outcome = body.outcome.length ? `<div class="ap-outcome${wide ? " ap-wide" : ""}">${body.outcome.map(c => card(c, outcomeWidth)).join("")}</div>` : "";
  const rounds = body.rounds.map(r => `<details class="ap-round" id="${esc(r.id)}" data-ap-disclosure${r.open ? " open" : ""}><summary class="ap-round-head"><b>${esc(r.title)}</b><span>${esc(r.caption)}</span></summary><div class="ap-round-body">
    ${card(r.data)}
    <div class="ap-fit-layout${wide ? " ap-wide" : ""}">${r.fit ? card(r.fit, left) : ""}<div class="ap-fit-aside">${r.parameters ? card(r.parameters, right) : ""}${r.identifiability ? card(r.identifiability, right) : ""}</div></div>
    ${r.landscape ? card(r.landscape) : ""}${r.proposals.map(c => card(c)).join("")}
    ${r.extras.map(c => `<details class="ap-extra" id="${esc(c.id)}" data-ap-disclosure><summary>${esc(c.heading)}<span>${esc(c.caption ?? "")}</span></summary><div>${panels(c.panels ?? [], inner, c.id)}</div></details>`).join("")}
  </div></details>`).join("");
  return `${jumps}<div class="ap-viewer ap-decision-view ap-investigation-view" data-ap-page="${esc(body.pageId)}">${card(body.summary)}${outcome}${rounds}</div>`;
}

export class AutophysMain {
  private abort = new AbortController();
  private model: MainModel | null = null;
  private width = 0;
  private setupStep = -1;
  private observer: ResizeObserver | null = null;

  constructor(private host: HTMLElement, onIntent: IntentHandler, private classes: MainClasses = {}, private hydrate: (host: HTMLElement) => void = () => {}) {
    host.addEventListener("scroll", () => this.highlightJump(), { capture: true, signal: this.abort.signal });
    host.addEventListener("click", (e) => {
      const jump = (e.target as Element).closest<HTMLElement>("[data-ap-jump]");
      if (jump?.dataset?.apJump && host.contains(jump)) { this.scrollToCard(jump.dataset.apJump!, true); return; }
      const el = (e.target as Element).closest?.<HTMLElement>(`[${ATTR.role}]`);
      const intent = el && host.contains(el) ? intentOf(el as HTMLButtonElement, "click") : null;
      if (intent) onIntent(intent);
    }, { signal: this.abort.signal });
    for (const event of ["input", "change"] as const) host.addEventListener(event, (e) => {
      const el = (e.target as Element).closest?.<HTMLInputElement>('[data-ap="field"]');
      const intent = el && host.contains(el) ? intentOf(el, event) : null;
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
    const previous = this.model?.body, nextBody = model.body;
    const samePage = previous?.kind === "investigation" && nextBody.kind === "investigation" && previous.pageId === nextBody.pageId;
    const selectionChanged = !samePage || (previous?.kind === "investigation" && nextBody.kind === "investigation" && previous.selectionId !== nextBody.selectionId);
    const disclosures = samePage ? [...this.host.querySelectorAll<HTMLDetailsElement>("[data-ap-disclosure]")].map(e => [e.id, e.open] as const) : [];
    const scroll = samePage ? this.host.querySelector(".ap-viewer")?.scrollTop ?? 0 : 0;
    const focused = document.activeElement;
    const input = focused instanceof HTMLInputElement && this.host.contains(focused) ? focused : null;
    const setupControl = focused instanceof HTMLElement && focused.closest(".ap-project-setup") && this.host.contains(focused) ? focused : null;
    const focus = input || setupControl;
    const caret = input ? { start: input.selectionStart, end: input.selectionEnd } : null;
    const setup = model.body.kind === "project-setup" ? model.body : null;
    const step = setup?.steps.findIndex(step => step.current) ?? -1;
    if (!setup) this.setupStep = -1;
    // std-button keeps its native focus target in shadow DOM. The app owns
    // navigation; focusing it must not scroll the first completed rows away.
    const focusControl = (el: HTMLElement) => (el.shadowRoot?.querySelector<HTMLElement>("button") ?? el).focus({ preventScroll: true });
    const restoreFocus = () => {
      if (focus?.id) {
        const next = this.host.querySelector<HTMLElement>(`[id="${CSS.escape(focus.id)}"]`);
        if (next && !next.hasAttribute("disabled")) {
          focusControl(next);
          if (next instanceof HTMLInputElement && caret?.start != null && caret.end != null) next.setSelectionRange(caret.start, caret.end);
        }
      }
      if (!setup || step === this.setupStep) return;
      const id = newProjectFocusTarget(setup);
      const target = id && this.host.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
      if (!target) return; // A save may render the next step before its action is enabled.
      focusControl(target);
      this.host.querySelector<HTMLElement>(".ap-project-setup")!.scrollTop = 0;
      this.setupStep = step;
    };
    const finish = () => {
      for (const [id, open] of disclosures) {
        const el = this.host.querySelector<HTMLDetailsElement>(`[id="${CSS.escape(id)}"]`);
        if (el) el.open = open;
      }
      const viewer = this.host.querySelector(".ap-viewer");
      if (viewer) viewer.scrollTop = scroll;
      restoreFocus();
      if (nextBody.kind === "investigation") {
        if (selectionChanged) this.scrollToCard(nextBody.target);
        this.highlightJump();
      }
    };
    this.model = model;
    this.width = Math.round(this.host.clientWidth) || 640;
    const next = document.createElement("template");
    next.innerHTML = mainMarkup(model, this.width, this.classes);
    const fresh = [...next.content.children] as HTMLElement[], kept = [...this.host.children] as HTMLElement[];
    if (kept.length !== fresh.length || kept.some((el, i) => el.tagName !== fresh[i].tagName)) {
      this.host.replaceChildren(...fresh);
      this.hydrate(this.host);
      finish();
      return;
    }
    kept.forEach((el, i) => {
      for (const a of [...el.attributes]) if (!fresh[i].hasAttribute(a.name)) el.removeAttribute(a.name);
      for (const a of [...fresh[i].attributes]) el.setAttribute(a.name, a.value);
      el.innerHTML = fresh[i].innerHTML;
    });
    this.hydrate(this.host);
    finish();
  }

  private scrollToCard(id: string, focus = false): void {
    const target = this.host.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    const viewer = this.host.querySelector<HTMLElement>(".ap-viewer");
    if (!target || !viewer) return;
    let parent: HTMLElement | null = target;
    while (parent && parent !== viewer) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
    viewer.scrollTop += target.getBoundingClientRect().top - viewer.getBoundingClientRect().top - 8;
    if (focus) {
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    this.highlightJump();
  }

  private highlightJump(): void {
    const viewer = this.host.querySelector<HTMLElement>(".ap-investigation-view");
    if (!viewer) return;
    const buttons = [...this.host.querySelectorAll<HTMLElement>("[data-ap-jump]")];
    const top = viewer.getBoundingClientRect().top;
    let active = buttons[0], nearest = -Infinity;
    for (const button of buttons) {
      const target = this.host.querySelector<HTMLElement>(`[id="${CSS.escape(button.dataset.apJump!)}"]`);
      if (!target || !target.getClientRects().length) continue;
      const y = target.getBoundingClientRect().top - top;
      if (y <= 48 && y >= nearest) { nearest = y; active = button; }
    }
    for (const button of buttons) {
      if (button === active) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    }
  }

  destroy(): void {
    this.abort.abort();
    this.observer?.disconnect();
    this.observer = null;
  }
}
