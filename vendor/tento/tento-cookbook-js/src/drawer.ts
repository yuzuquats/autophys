import type { Deck } from "./deck.ts";
import type { Header } from "./header.ts";
import type { Panels } from "./panels.ts";
import type { Tutorial } from "./tutorial.ts";
import { arrowStage, type Stage } from "./model.ts";
import { readRoute, routeUrl } from "./route.ts";
import { ease, h, isField, reducedMotion } from "./dom.ts";

export type Drawer = {
  readonly stage: Stage;
  open(): void;
  close(): void;
};

/**
 * The landing surface and the app beneath it. The deck sits on one white
 * surface; opening the app lowers that surface to a peek at the bottom of the
 * screen, where the tutorial appears, while the panels slide in from their
 * edges. Finishing the tutorial lowers the surface out of the way. Every move
 * starts from the surface's displayed position, so an interrupted move
 * reverses without a jump.
 *
 * The URL holds the open/closed state (route.ts): opening and closing push
 * history, so Back and Forward retrace them. `onOpen` runs as the app starts
 * to open (mount the app); `onClosed` once the deck has settled back.
 */
export function installDrawer(parts: {
  root: HTMLElement;
  header: Header;
  deck: Deck;
  panels: Panels;
  tutorial: Tutorial;
  appPath: string;
  onOpen(): void;
  onClosed(): void;
  onStage?(stage: Stage): void;
}): Drawer {
  const { root, header, deck, panels, tutorial, appPath } = parts;
  const landing = h("div", "ck-landing");
  const content = h("div", "ck-landing-content", null, deck.el);
  const tour = h("section", "ck-tour-peek", { "aria-label": "Tutorial" }, tutorial.el);
  tour.inert = true;
  landing.append(content, tour);
  root.append(panels.el, landing, header.el);

  let stage: Stage = "landing";
  let revision = 0;
  let animation: Animation | null = null;
  let trigger: HTMLElement | null = null;
  const peek = () => Math.max(0, Math.min(200, innerHeight - 80));
  const transformFor = (s: Stage) =>
    s === "landing" ? "translateY(0px)" : `translateY(${s === "tour" ? innerHeight - peek() : innerHeight}px)`;

  async function setStage(next: Stage): Promise<void> {
    if (next === stage) return;
    const previous = stage;
    stage = next;
    const own = ++revision;
    const from = getComputedStyle(landing).transform;
    animation?.cancel();
    document.documentElement.dataset.ckStage = next;
    const open = next !== "landing";
    if (open && previous === "landing") parts.onOpen();
    header.setAppState(open);
    panels.setVisible(true);
    panels.setOpen(open);
    panels.setPeek(next === "tour" ? peek() : 0);
    if (!open) panels.setReady(false);
    landing.toggleAttribute("data-lowered", open);
    // The deck and the header link are about to go inert. If focus was on
    // them (whatever opened the app), hand it to the way back; a deep link,
    // with nothing focused, moves nothing.
    const active = document.activeElement;
    if (open && previous === "landing" && active && active !== document.body && !panels.el.contains(active)) {
      header.brand.focus({ preventScroll: true });
    }
    content.inert = open;
    tour.inert = next !== "tour";
    if (next === "tour") tutorial.start();
    else tutorial.clear();
    parts.onStage?.(next);

    const to = transformFor(next);
    landing.style.transform = to;
    const long = previous === "landing" || next === "landing";
    const duration = reducedMotion() ? 0 : long ? 700 : 380;
    animation = landing.animate([{ transform: from === "none" ? "translateY(0px)" : from }, { transform: to }], {
      duration,
      easing: ease,
    });
    await animation.finished.catch(() => {});
    if (own !== revision) return;
    animation = null;
    if (open) panels.setReady(true);
    else {
      panels.setVisible(false);
      parts.onClosed();
      trigger?.focus({ preventScroll: true });
      trigger = null;
    }
  }

  function open(push = true): void {
    if (stage !== "landing") return;
    if (push) history.pushState({ cookbook: "app" }, "", routeUrl({ app: true, item: null }, appPath));
    void setStage("tour");
  }

  function close(push = true): void {
    if (stage === "landing") return;
    if (push) history.pushState({ cookbook: "landing" }, "", "/");
    void setStage("landing");
  }

  tutorial.onDone = () => void setStage("app");

  // Any same-origin link into the app path opens the drawer in place.
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    ) return;
    const link = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link || link.origin !== location.origin || !readRoute(link.pathname, appPath).app) return;
    event.preventDefault();
    trigger = link;
    open();
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    ) return;
    if (isField(event.target)) return;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && stage === "landing") {
      event.preventDefault();
      deck.step(event.key === "ArrowRight" ? 1 : -1);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.repeat) {
      const next = arrowStage(stage, event.key);
      if (!next) return;
      event.preventDefault();
      if (next === "landing") close();
      else if (stage === "landing") open();
      else void setStage(next);
    } else if (event.key === "Escape") {
      if (panels.closeSheet()) event.preventDefault();
      else if (stage === "tour") {
        event.preventDefault();
        void setStage("app");
      }
    }
  });

  addEventListener("popstate", () => {
    if (readRoute(location.pathname, appPath).app) open(false);
    else close(false);
  });

  addEventListener("resize", () => {
    if (animation) return;
    landing.style.transform = transformFor(stage);
    panels.setPeek(stage === "tour" ? peek() : 0);
  });

  document.documentElement.dataset.ckStage = "landing";
  if (readRoute(location.pathname, appPath).app) {
    // Back from an app opened by URL lands on the deck rather than leaving.
    const here = location.pathname;
    history.replaceState({ cookbook: "landing" }, "", "/");
    history.pushState({ cookbook: "app" }, "", here);
    requestAnimationFrame(() => open(false));
  }

  return {
    get stage() {
      return stage;
    },
    open: () => open(),
    close: () => close(),
  };
}
