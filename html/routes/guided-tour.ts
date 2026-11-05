/**
 * The Autophys tour, as the cookbook tutorial's source. When the tour starts
 * it swaps in a controller on the demo fixture, keeping the user's own
 * controller and view to put back when it ends. Each step selects real rows
 * and opens the panels it needs (its enter action), and the cookbook
 * highlights the step's component, with a native-size fixture image on the left.
 * The cookbook owns the sheet, the arrows, Back/Next/Done and Esc.
 */
import type { Cookbook } from "@tento-cookbook/lib.ts";
import { Controller } from "../client/controller.ts";
import { Store } from "../client/store.ts";
import { fixtures } from "../client/fixtures/source.ts";
import { TourSnapshot } from "../client/tutorial.ts";
import { tourOpeningLayout, tourSteps, type TourPart } from "./guided-tour-steps.ts";
import { guidedTourStyles } from "./guided-tour-styles.ts";
import { tourImages } from "./guided-tour-images.ts";

type Host = { get(): Controller; set(controller: Controller): void; redraw(): void; startTour(): void };
type Scroll = { path: number[]; top: number; left: number };
/** App-only child indexes include -1 at an open shadow root; survives redraws.
 * Resolve saved paths directly. Searching every saved path for every document
 * element was quadratic, and also restored the unrelated landing/docs scroll.
 * Window scroll is captured separately by the tour snapshot.
 */
function scrollTree(restore?: Scroll[]): Scroll[] {
  const positions: Scroll[] = [];
  const app = document.querySelector<HTMLElement>(".ck-app");
  if (!app) return positions;
  if (restore) {
    for (const saved of restore) {
      let node: Element | ShadowRoot | null = app;
      for (const index of saved.path) {
        node = index === -1
          ? node instanceof Element ? node.shadowRoot : null
          : node?.children.item(index) ?? null;
        if (!node) break;
      }
      if (node instanceof HTMLElement) {
        if (node.scrollTop !== saved.top) node.scrollTop = saved.top;
        if (node.scrollLeft !== saved.left) node.scrollLeft = saved.left;
      }
    }
    return positions;
  }
  const walk = (root: Element | ShadowRoot, path: number[]) => {
    if (root instanceof HTMLElement) positions.push({ path, top: root.scrollTop, left: root.scrollLeft });
    if (root instanceof Element && root.shadowRoot) walk(root.shadowRoot, [...path, -1]);
    [...root.children].forEach((el, i) => walk(el, [...path, i]));
  };
  walk(app, []);
  return positions;
}
/** A sidebar row by id; rows live in the tree's shadow root, out of a selector's reach. */
function rowElement(id: string): HTMLElement | null {
  const tree = document.querySelector("std-tree-list.ap-tree");
  return tree?.shadowRoot?.querySelector<HTMLElement>('[role="treeitem"][data-id="' + CSS.escape(id) + '"] > .line') ?? null;
}
const target = (selector: string): Cookbook.Tutorial.Target =>
  selector.startsWith("row:") ? () => rowElement(selector.slice(4)) : selector;

export function mountGuidedTour(host: Host) {
  const abort = new AbortController(), { signal } = abort;
  const style = document.createElement("style"); style.textContent = guidedTourStyles; document.head.append(style);
  const chip = document.createElement("span"); chip.className = "ap-tour-chip"; chip.textContent = "Demo data · tour"; chip.hidden = true;
  document.body.append(chip);
  const seenKey = "autophys.tour.seen." + (document.querySelector("#ap-account")?.textContent?.trim() ?? "local");
  const panels = () => document.querySelector<HTMLElement>(".ck-panels")!;
  let demo: Controller | null = null, unsubscribe: (() => void) | null = null, disposed = false;
  /** Bumped when a tour ends, so a start still loading the demo gives up. */
  let ended = 0, activePart = -1;
  const images = new Map<number, HTMLImageElement>();
  function preloadImage(index: number): HTMLImageElement | undefined {
    if (!tourImages[index]) return;
    let image = images.get(index);
    if (!image) {
      image = new Image(320, 166);
      image.className = "ap-tour-image";
      image.loading = "eager";
      image.alt = ""; // The adjacent title and body describe this decorative crop.
      image.src = tourImages[index];
      images.set(index, image);
    }
    return image;
  }

  function panel(which: "sidebar" | "details", open: boolean) {
    const button = document.querySelector<HTMLButtonElement>(".ck-" + which + "-toggle");
    if (button && (button.getAttribute("aria-pressed") === "true") !== open) button.click();
  }
  function layout(part: Pick<TourPart, "surface" | "details">) {
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
    scrollTree(saved.scroll);
    // Back has already restored the landing offset in the drawer. Only the
    // app stage belongs to this snapshot; never overwrite the landing scroll.
    if (document.documentElement.dataset.ckStage === "app") {
      window.scrollTo(saved.window[0], saved.window[1]);
    }
    const restoreScroll = () => { if (!snapshot.active && !disposed) scrollTree(saved.scroll); };
    requestAnimationFrame(restoreScroll);
    setTimeout(restoreScroll, 400);
    if (saved.focus?.isConnected) saved.focus.focus({ preventScroll: true });
  });

  function toStep(part: TourPart, group: string | undefined, index: number): Cookbook.Tutorial.Step {
    return {
      title: part.title,
      body: part.body,
      group,
      target: part.target.map(target),
      enter() {
        activePart = index;
        preloadImage(index);
        preloadImage(index + 1);
        if (!demo) return;
        if (part.select) demo.handle({ kind: "select", id: part.select });
        layout(part);
      },
      // Static, already-preloaded images replace the expensive live-DOM clone.
      preview: (_targets, slot) => {
        const image = preloadImage(index)!;
        slot.removeAttribute("inert"); // Permit native-size crops to pan on narrow screens.
        const show = () => {
          if (disposed || !snapshot.active || activePart !== index || !image.naturalWidth) return;
          slot.replaceChildren(image);
          slot.closest(".ck-tour")?.setAttribute("data-preview", "");
        };
        if (image.complete) show();
        else image.addEventListener("load", show, { once: true });
      },
    };
  }

  const source: Cookbook.Tutorial.Source = {
    async start() {
      if (disposed) return [];
      const own = ended;
      // The shell opens in this task. Save the user’s layout and apply the first
      // lesson before awaiting data/images, so Details never paints then closes.
      snapshot.start();
      layout(tourOpeningLayout);
      const controller = new Controller(new Store(fixtures()), { user: "tour", now: () => "" });
      preloadImage(1);
      await Promise.all([controller.store.start(), preloadImage(0)!.decode().catch(() => {})]);
      if (disposed || own !== ended) { controller.store.close(); return []; }
      demo = controller;
      controller.shell = { download: () => {}, picked: () => {} };
      unsubscribe = controller.subscribe(host.redraw);
      host.set(controller);
      chip.hidden = false;
      document.documentElement.dataset.apTour = "";
      host.redraw();
      return tourSteps(controller.store.snapshot()!.workspace)
        .flatMap((parts, i) => parts.map(part => ({ part, group: parts.length > 1 ? "step-" + i : undefined })))
        .map(({ part, group }, index) => toStep(part, group, index));
    },
    finish({ completed }) {
      ended++;
      activePart = -1;
      if (completed) { try { localStorage.setItem(seenKey, "true"); } catch { /* usable without storage */ } }
      snapshot.finish();
    },
  };

  // No in-app entry point: the deck's Get started slide opens the tour; tests start it with this event.
  document.addEventListener("ap-tour-start", () => host.startTour(), { signal });
  return {
    source,
    dispose() { source.finish?.({ completed: false }); disposed = true; abort.abort(); style.remove(); chip.remove(); },
  };
}
