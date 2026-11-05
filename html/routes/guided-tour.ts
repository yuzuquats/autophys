import { Controller } from "../client/controller.ts";
import { Store } from "../client/store.ts";
import { fixtures } from "../client/fixtures/source.ts";
import { TourSession } from "../client/tutorial.ts";
import { tourSteps, type TourPart } from "./guided-tour-steps.ts";
import { guidedTourStyles } from "./guided-tour-styles.ts";
import { previewComponent } from "./guided-tour-preview.ts";

type Host = { get(): Controller; set(controller: Controller): void; redraw(): void };
type Scroll = { path: number[]; top: number; left: number };
/** Child indexes include -1 at an open shadow root; survives redraws of the same view. */
function scrollTree(restore?: Scroll[]): Scroll[] {
  const positions: Scroll[] = [];
  const walk = (root: Element | ShadowRoot, path: number[]) => {
    if (root instanceof HTMLElement) {
      if (restore) {
        const saved = restore.find(s => s.path.join("/") === path.join("/"));
        if (saved) { root.scrollTop = saved.top; root.scrollLeft = saved.left; }
      } else positions.push({ path, top: root.scrollTop, left: root.scrollLeft });
    }
    if (root instanceof Element && root.shadowRoot) walk(root.shadowRoot, [...path, -1]);
    [...root.children].forEach((el, i) => walk(el, [...path, i]));
  };
  walk(document.documentElement, []);
  return positions;
}
function targetElement(selector: string): HTMLElement | null {
  if (selector.startsWith("row:")) {
    const id = selector.slice(4);
    const tree = document.querySelector("std-tree-list.ap-tree");
    return tree?.shadowRoot?.querySelector<HTMLElement>('[role="treeitem"][data-id="' + CSS.escape(id) + '"] > .line') ?? null;
  }
  return document.querySelector<HTMLElement>(selector);
}
function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && r.left >= 0 && r.right <= innerWidth && r.top >= 65 && r.bottom < (document.querySelector(".ap-guided-tour")?.getBoundingClientRect().top ?? innerHeight);
}

export function mountGuidedTour(host: Host) {
  const abort = new AbortController(), { signal } = abort;
  const style = document.createElement("style"); style.textContent = guidedTourStyles; document.head.append(style);
  const sheet = document.createElement("section"); sheet.className = "ap-guided-tour"; sheet.hidden = true;
  sheet.setAttribute("role", "region"); sheet.setAttribute("aria-label", "Autophys guided tour");
  sheet.innerHTML = `<div class="ap-tour-inner">
    <div class="ap-tour-visual"><div class="ap-tour-preview" aria-hidden="true" inert></div><p class="ap-tour-label"></p></div>
    <div class="ap-tour-lesson"><div class="ap-tour-bars" role="img"></div><h2 class="ap-tour-title"></h2>
    <p class="ap-tour-body" aria-live="polite"></p><div class="ap-tour-actions">
    <button type="button" class="ap-tour-back">← Back</button><button type="button" class="ap-tour-next">Next →</button>
    <span class="ap-tour-hint"></span></div></div>
    <button type="button" class="ap-tour-close" aria-label="Close tutorial"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>`;
  const chip = document.createElement("span"); chip.className = "ap-tour-chip"; chip.textContent = "Demo data · tour"; chip.hidden = true;
  const menu = document.createElement("details"); menu.className = "ap-tour-menu";
  menu.innerHTML = '<summary aria-label="App menu">Menu</summary><button type="button">Take the tour</button>';
  document.querySelector(".ck-nav-links")?.append(menu);
  document.body.append(sheet, chip);
  const $ = <T extends HTMLElement>(s: string) => sheet.querySelector<T>(s)!;
  const next = $<HTMLButtonElement>(".ap-tour-next"), back = $<HTMLButtonElement>(".ap-tour-back");
  const seenKey = "autophys.tour.seen." + (document.querySelector("#ap-account")?.textContent?.trim() ?? "local");
  const panels = () => document.querySelector<HTMLElement>(".ck-panels")!;
  let demo: Controller | null = null, steps: ReturnType<typeof tourSteps> = [];
  let enterFrame = 0, previewFrame = 0;
  let unsubscribe: (() => void) | null = null, frame = 0, revision = 0, busy = false, disposed = false, paused = false;
  let rings: HTMLElement[] = [], targets: HTMLElement[] = [], current: TourPart | undefined;
  const cancelFrames = () => {
    cancelAnimationFrame(frame); cancelAnimationFrame(enterFrame); cancelAnimationFrame(previewFrame);
    previewFrame = 0;
  };
  const clearRings = () => { cancelFrames(); rings.forEach(r => r.remove()); rings = []; };
  function panel(which: "sidebar" | "details", open: boolean) {
    const button = document.querySelector<HTMLButtonElement>(".ck-" + which + "-toggle")!;
    if ((button.getAttribute("aria-pressed") === "true") !== open) button.click();
  }
  function layout(part: TourPart) {
    if (matchMedia("(max-width:760px)").matches) {
      // Phone panels are mutually exclusive. Expose the actual targeted surface.
      const mobile = panels().dataset.mobile;
      if (mobile !== "main") panel(mobile as "sidebar" | "details", false);
      if (part.surface !== "main") panel(part.surface, true);
    } else {
      panel("sidebar", true);
      panel("details", part.details);
    }
    host.redraw(); // Also reconcile the app's inert Details state after a shell toggle.
  }
  function drawRings() {
    cancelAnimationFrame(frame);
    targets = current!.target.map(targetElement).filter((e): e is HTMLElement => !!e);
    // Keep the same nodes across steps, including while a panel is sliding in.
    while (rings.length > targets.length) rings.pop()!.remove();
    while (rings.length < targets.length) {
      const ring = document.createElement("div"); ring.className = "ck-target-ring ap-tour-halo";
      ring.setAttribute("aria-hidden", "true"); document.body.append(ring); rings.push(ring);
    }
    targets.forEach((target, i) => { rings[i].dataset.target = current!.target.find(s => targetElement(s) === target); });
    const own = revision;
    const preview = $(".ap-tour-preview"), visual = $(".ap-tour-visual");
    const place = () => {
      const bounds = targets.map(t => t.getBoundingClientRect());
      const shown = targets.map(visible);
      const needsPreview = targets.length < current!.target.length || shown.some(v => !v);
      visual.hidden = !needsPreview;
      sheet.dataset.preview = needsPreview ? "true" : "false";
      if (!needsPreview) {
        cancelAnimationFrame(previewFrame); previewFrame = 0;
      } else if (!previewFrame && preview.dataset.ready !== "true") {
        // A separate frame lets the ready state paint before copying any DOM.
        previewFrame = requestAnimationFrame(() => {
          previewFrame = 0;
          if (own !== revision || !session.active || paused || visual.hidden) return;
          previewComponent(preview, targets);
        });
      }
      bounds.forEach((r, i) => {
        rings[i].hidden = !shown[i];
        Object.assign(rings[i].style, { left:r.left - 4 + "px", top:r.top - 4 + "px", width:r.width + 8 + "px", height:r.height + 8 + "px", borderRadius:"8px" });
      });
      frame = requestAnimationFrame(place);
    };
    place();
  }
  function enter() {
    if (!demo || !current) return;
    const own = ++revision;
    paused = false; cancelFrames(); sheet.dataset.ready = "false";
    const preview = $(".ap-tour-preview");
    preview.replaceChildren(); delete preview.dataset.ready;
    if (current.select) demo.handle({ kind:"select", id:current.select });
    layout(current);
    const { step, substep } = session.pager.position;
    sheet.dataset.step = String(step + 1); sheet.dataset.substep = String(substep);
    sheet.dataset.selection = demo.view().sidebar.selectedId ?? "";
    $(".ap-tour-title").textContent = current.title;
    $(".ap-tour-body").textContent = current.body;
    $(".ap-tour-label").textContent = current.label;
    $(".ap-tour-bars").innerHTML = steps.map((_, i) => '<i><b style="width:' + (i < step ? 100 : i === step ? session.pager.progress * 100 : 0) + '%"></b></i>').join("");
    $(".ap-tour-bars").setAttribute("aria-label", "Step " + (step + 1) + " of " + steps.length + (steps[step].length > 1 ? ", part " + (substep + 1) + " of " + steps[step].length : ""));
    $(".ap-tour-hint").textContent = (step + 1) + " of " + steps.length + " · Esc restores your view";
    back.disabled = session.pager.first;
    next.textContent = session.pager.last ? "Done" : "Next →";
    // Selection/redraw and instant scrolling precede the next paint. The halo
    // follows moving targets; readiness never waits for slides or preview copies.
    const found = current.target.map(targetElement).filter((e): e is HTMLElement => !!e);
    for (const t of found) t.scrollIntoView({ block:"nearest", inline:"nearest", behavior:"instant" });
    enterFrame = requestAnimationFrame(() => {
      if (own !== revision || !session.active) return;
      drawRings(); sheet.dataset.ready = "true";
    });
  }

  const session = new TourSession([1,1,1,1,2,1,1,1,1], () => ({
    controller: host.get(), scroll: scrollTree(), focus: document.activeElement as HTMLElement | null,
    sidebar: document.querySelector(".ck-sidebar-toggle")?.getAttribute("aria-pressed") === "true",
    details: document.querySelector(".ck-details-toggle")?.getAttribute("aria-pressed") === "true",
    mobile: panels().dataset.mobile, window: [scrollX, scrollY],
  }), saved => {
    ++revision; clearRings(); unsubscribe?.(); unsubscribe = null;
    demo?.store.close(); demo = null;
    host.set(saved.controller);
    delete document.documentElement.dataset.apTour; sheet.hidden = chip.hidden = true;
    if (matchMedia("(max-width:760px)").matches) {
      const mobile = panels().dataset.mobile;
      if (mobile !== "main") panel(mobile as "sidebar" | "details", false);
      if (saved.mobile !== "main") panel(saved.mobile as "sidebar" | "details", true);
    } else { panel("sidebar", saved.sidebar); panel("details", saved.details); }
    host.redraw();
    // Restore immediately, and once after the renderer's layout/FLIP has settled.
    scrollTree(saved.scroll); window.scrollTo(saved.window[0], saved.window[1]);
    const restoreScroll = () => { if (!session.active && !disposed) scrollTree(saved.scroll); };
    requestAnimationFrame(restoreScroll);
    setTimeout(restoreScroll, 400);
    saved.focus?.isConnected && saved.focus.focus({ preventScroll:true });
  }, position => { current = steps[position.step][position.substep]; host.set(demo!); sheet.hidden = chip.hidden = false; document.documentElement.dataset.apTour = ""; enter(); });

  async function start() {
    if (busy || session.active || disposed) return;
    busy = true; menu.open = false;
    const controller = new Controller(new Store(fixtures()), { user:"tour", now:() => "" });
    try {
      await controller.store.start();
      if (disposed) { controller.store.close(); return; }
      demo = controller; steps = tourSteps(controller.store.snapshot()!.workspace);
      controller.shell = { download:() => {}, picked:() => {} };
      unsubscribe = controller.subscribe(host.redraw);
      session.start();
      next.focus({ preventScroll:true });
    } finally { busy = false; }
  }
  function finish(seen = false) {
    if (seen) { try { localStorage.setItem(seenKey, "true"); } catch { /* usable without storage */ } }
    session.finish();
  }
  function move(delta: 1 | -1) {
    if (paused && delta === 1) { enter(); return; }
    if (delta === 1 && session.pager.last) finish(true);
    else session.move(delta);
  }
  next.addEventListener("click", () => move(1), { signal });
  back.addEventListener("click", () => move(-1), { signal });
  $(".ap-tour-close").addEventListener("click", () => finish(), { signal });
  menu.querySelector("button")!.addEventListener("click", () => { void start(); }, { signal });
  document.addEventListener("keydown", e => {
    if (!session.active) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(); return; }
    if (e.isComposing || e.altKey || e.metaKey || e.ctrlKey || (e.target as HTMLElement).matches("input,textarea,select,[contenteditable]")) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); move(e.key === "ArrowRight" ? 1 : -1); }
  }, { capture:true, signal });
  document.addEventListener("click", e => {
    if (!e.isTrusted || !session.active || sheet.contains(e.target as Node) || menu.contains(e.target as Node)) return;
    if ((e.target as Element).closest(".ck-brand")) { finish(); return; }
    if (!targets.some(t => e.composedPath().includes(t))) {
      paused = true; next.textContent = "Resume tour"; clearRings();
    }
  }, { signal });
  const empty = document.createElement("button"); empty.type = "button"; empty.className = "ap-tour-empty"; empty.textContent = "Take the tour";
  empty.addEventListener("click", () => { void start(); }, { signal });
  function syncEntry() {
    const body = host.get().view().main.body;
    const show = !session.active && ["empty", "onboarding", "signed-out"].includes(body.kind);
    const main = document.querySelector(".ck-main");
    if (show && main && !empty.isConnected) main.append(empty);
    if (!show) empty.remove();
  }
  const observer = new MutationObserver(syncEntry);
  observer.observe(document.querySelector(".ck-main")!, { childList:true, subtree:true });
  syncEntry();
  return {
    start,
    offer() {
      // The cookbook has no tutorial extension point. Complete its empty shell
      // transition, then use our local sheet. Vendor code stays untouched.
      document.querySelector<HTMLButtonElement>(".ck-tour-dismiss")?.click();
      let offered = false; try { offered = !!localStorage.getItem(seenKey) || !!sessionStorage.getItem(seenKey + ".offered"); } catch { /* offer once for this mount */ }
      if (offered) return;
      try { sessionStorage.setItem(seenKey + ".offered", "true"); } catch { /* optional */ }
      const wait = () => { if (disposed) return; if (!panels().hasAttribute("data-ready")) { requestAnimationFrame(wait); return; } void start(); };
      requestAnimationFrame(wait);
    },
    dispose() { finish(); disposed = true; observer.disconnect(); abort.abort(); clearRings(); style.remove(); sheet.remove(); chip.remove(); menu.remove(); empty.remove(); },
  };
}
