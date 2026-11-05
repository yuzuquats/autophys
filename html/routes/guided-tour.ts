/**
 * The Autophys tour, as the cookbook tutorial's source. When the tour starts
 * it swaps in a controller on the demo fixture, keeping the user's own
 * controller and view to put back when it ends. Each step selects real rows
 * and opens the panels it needs (its enter action), and the cookbook
 * highlights the step's component, with a clipped copy of it on the left when
 * the live one is out of sight.
 * The cookbook owns the sheet, the arrows, Back/Next/Done and Esc.
 */
import type { Cookbook } from "@tento-cookbook/lib.ts";
import { Controller } from "../client/controller.ts";
import { Store } from "../client/store.ts";
import { fixtures } from "../client/fixtures/source.ts";
import { TourSnapshot } from "../client/tutorial.ts";
import { tourSteps, type TourPart } from "./guided-tour-steps.ts";
import { guidedTourStyles } from "./guided-tour-styles.ts";
import { previewComponent } from "./guided-tour-preview.ts";

type Host = { get(): Controller; set(controller: Controller): void; redraw(): void; startTour(): void };
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
/** A sidebar row by id; rows live in the tree's shadow root, out of a selector's reach. */
function rowElement(id: string): HTMLElement | null {
  const tree = document.querySelector("std-tree-list.ap-tree");
  return tree?.shadowRoot?.querySelector<HTMLElement>('[role="treeitem"][data-id="' + CSS.escape(id) + '"] > .line') ?? null;
}
function obscured(el: HTMLElement, slot: HTMLElement): boolean {
  const r = el.getBoundingClientRect(), sheet = slot.closest(".ck-tour-peek")?.getBoundingClientRect().top ?? innerHeight;
  return r.top < 56 || r.bottom > sheet || r.left < 0 || r.right > innerWidth;
}
const target = (selector: string): Cookbook.Tutorial.Target =>
  selector.startsWith("row:") ? () => rowElement(selector.slice(4)) : selector;

export function mountGuidedTour(host: Host) {
  const abort = new AbortController(), { signal } = abort;
  const style = document.createElement("style"); style.textContent = guidedTourStyles; document.head.append(style);
  const chip = document.createElement("span"); chip.className = "ap-tour-chip"; chip.textContent = "Demo data · tour"; chip.hidden = true;
  const menu = document.createElement("details"); menu.className = "ap-tour-menu";
  menu.innerHTML = '<summary aria-label="App menu">Menu</summary><button type="button">Take the tour</button>';
  document.querySelector(".ck-nav-links")?.append(menu);
  document.body.append(chip);
  const seenKey = "autophys.tour.seen." + (document.querySelector("#ap-account")?.textContent?.trim() ?? "local");
  const panels = () => document.querySelector<HTMLElement>(".ck-panels")!;
  let demo: Controller | null = null, unsubscribe: (() => void) | null = null, disposed = false;
  /** Bumped when a tour ends, so a start still loading the demo gives up. */
  let ended = 0;

  function panel(which: "sidebar" | "details", open: boolean) {
    const button = document.querySelector<HTMLButtonElement>(".ck-" + which + "-toggle");
    if (button && (button.getAttribute("aria-pressed") === "true") !== open) button.click();
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
  const snapshot = new TourSnapshot(() => ({
    controller: host.get(), scroll: scrollTree(), focus: document.activeElement as HTMLElement | null,
    sidebar: document.querySelector(".ck-sidebar-toggle")?.getAttribute("aria-pressed") === "true",
    details: document.querySelector(".ck-details-toggle")?.getAttribute("aria-pressed") === "true",
    mobile: panels().dataset.mobile, window: [scrollX, scrollY],
  }), saved => {
    unsubscribe?.(); unsubscribe = null;
    demo?.store.close(); demo = null;
    host.set(saved.controller);
    delete document.documentElement.dataset.apTour; chip.hidden = true;
    if (matchMedia("(max-width:760px)").matches) {
      const mobile = panels().dataset.mobile;
      if (mobile !== "main") panel(mobile as "sidebar" | "details", false);
      if (saved.mobile !== "main") panel(saved.mobile as "sidebar" | "details", true);
    } else { panel("sidebar", saved.sidebar); panel("details", saved.details); }
    host.redraw();
    // Restore immediately, and once after the renderer's layout/FLIP has settled.
    scrollTree(saved.scroll); window.scrollTo(saved.window[0], saved.window[1]);
    const restoreScroll = () => { if (!snapshot.active && !disposed) scrollTree(saved.scroll); };
    requestAnimationFrame(restoreScroll);
    setTimeout(restoreScroll, 400);
    if (saved.focus?.isConnected) saved.focus.focus({ preventScroll: true });
  });

  function toStep(part: TourPart, group: string | undefined): Cookbook.Tutorial.Step {
    return {
      title: part.title,
      body: part.body,
      group,
      target: part.target.map(target),
      enter() {
        if (!demo) return;
        if (part.select) demo.handle({ kind: "select", id: part.select });
        layout(part);
      },
      // A preview only when the live component is out of sight (off screen or under the sheet).
      preview: (targets, slot) => { if (targets.some(t => obscured(t, slot))) previewComponent(slot, [...targets]); },
    };
  }

  const source: Cookbook.Tutorial.Source = {
    async start() {
      if (disposed) return [];
      menu.open = false;
      const own = ended;
      const controller = new Controller(new Store(fixtures()), { user: "tour", now: () => "" });
      await controller.store.start();
      if (disposed || own !== ended) { controller.store.close(); return []; }
      snapshot.start();
      demo = controller;
      controller.shell = { download: () => {}, picked: () => {} };
      unsubscribe = controller.subscribe(host.redraw);
      host.set(controller);
      chip.hidden = false;
      document.documentElement.dataset.apTour = "";
      host.redraw();
      return tourSteps(controller.store.snapshot()!.workspace)
        .flatMap((parts, i) => parts.map(part => toStep(part, parts.length > 1 ? "step-" + i : undefined)));
    },
    finish({ completed }) {
      ended++;
      if (completed) { try { localStorage.setItem(seenKey, "true"); } catch { /* usable without storage */ } }
      snapshot.finish();
    },
  };

  menu.querySelector("button")!.addEventListener("click", () => { menu.open = false; host.startTour(); }, { signal });
  const empty = document.createElement("button"); empty.type = "button"; empty.className = "ap-tour-empty"; empty.textContent = "Take the tour";
  empty.addEventListener("click", () => host.startTour(), { signal });
  function syncEntry() {
    const body = host.get().view().main.body;
    const show = !snapshot.active && ["empty", "onboarding", "signed-out"].includes(body.kind);
    const main = document.querySelector(".ck-main");
    if (show && main && !empty.isConnected) main.append(empty);
    if (!show) empty.remove();
  }
  const observer = new MutationObserver(syncEntry);
  observer.observe(document.querySelector(".ck-main")!, { childList: true, subtree: true });
  syncEntry();
  return {
    source,
    dispose() { source.finish?.({ completed: false }); disposed = true; observer.disconnect(); abort.abort(); style.remove(); chip.remove(); menu.remove(); empty.remove(); },
  };
}
