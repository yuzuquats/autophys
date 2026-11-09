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
  /** Show the tutorial from its first step: opens the app from the deck, or lowers the surface back to the tour. */
  tour(): void;
  /** Discard retained lessons; keep the current route and drawer open state. */
  endTour(): void;
};

/**
 * The landing surface and the app beneath it. The deck sits on one white
 * surface; opening the app lowers that surface to a peek at the bottom of the
 * screen, where the tutorial appears, while the panels slide in from their
 * edges. Finishing the tutorial lowers the surface out of the way. Every move
 * starts from the surface's displayed position, so an interrupted move
 * reverses without a jump.
 *
 * Left and right step the deck on the landing and the tutorial in the tour;
 * past either end of the tutorial they return to the deck. A deck slide
 * marked opensApp opens the app as the deck steps onto it (Deck.onLaunch).
 *
 * The URL holds the open/closed state (route.ts): opening and closing push
 * history, so Back and Forward retrace them. `onOpen` runs as the app starts
 * to open (mount the app); `onClosed` once the deck has settled back.
 */
export function installDrawer(parts: {
  root: HTMLElement;
  header: Header;
  deck: Deck;
  footer?: HTMLElement;
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
  if (parts.footer) root.append(parts.footer);

  let stage: Stage = "landing";
  let revision = 0;
  let animation: Animation | null = null;
  let trigger: HTMLElement | null = null;
  let landingScroll = 0;
  let fitting: Animation | null = null;
  // The peek is 200px, or taller when a step needs it: a long body, a preview
  // column or a narrow window can wrap a step past 200px, and the bottom of the
  // peek would cut off Back and Next. Within one tour it does not shrink back,
  // so stepping through does not bounce the app above it.
  let fitted = 0;
  const natural = () => {
    const style = tutorial.el.style;
    style.height = "auto";
    const px = Math.ceil(tutorial.el.getBoundingClientRect().height);
    style.height = "";
    return px;
  };
  const peek = () => {
    fitted = Math.max(fitted, natural());
    return Math.max(0, Math.min(Math.max(200, fitted), innerHeight - 80));
  };
  /** Size the peek for the current stage; returns its height, 0 off the tour. */
  const applyPeek = () => {
    const px = stage === "tour" ? peek() : 0;
    if (px) tour.style.height = `${px}px`;
    panels.setPeek(px);
    return px;
  };
  const transformFor = (s: Stage, px: number) =>
    s === "landing" ? "translateY(0px)" : `translateY(${s === "tour" ? innerHeight - px : innerHeight}px)`;

  /** Grow the peek to a step that rendered taller. A stage move in flight refits when it lands. */
  function refit(): void {
    if (stage !== "tour" || animation) return;
    const before = parseFloat(tour.style.height) || 0;
    const px = applyPeek();
    if (px === before) return;
    const from = new DOMMatrixReadOnly(getComputedStyle(landing).transform).m42;
    const to = transformFor("tour", px);
    fitting?.cancel();
    landing.style.transform = to;
    fitting = reducedMotion() ? null : landing.animate([{ transform: `translateY(${from}px)` }, { transform: to }], {
      duration: 240,
      easing: ease,
    });
  }
  let refitFrame = 0;
  new MutationObserver(() => {
    cancelAnimationFrame(refitFrame);
    refitFrame = requestAnimationFrame(refit);
  }).observe(tutorial.el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-preview"] });

  async function setStage(next: Stage): Promise<void> {
    if (next === stage) return;
    const previous = stage;
    stage = next;
    const own = ++revision;
    const from = new DOMMatrixReadOnly(getComputedStyle(landing).transform);
    const previousScroll = scrollY;
    if (previous === "landing") landingScroll = previousScroll;
    animation?.cancel();
    fitting?.cancel();
    fitting = null;
    const open = next !== "landing";
    // Measure the header before locking away the landing's scroll offset.
    if (open) header.setAppState(true);
    document.documentElement.dataset.ckStage = next;
    if (open && previous === "landing") parts.onOpen();
    panels.setVisible(true);
    panels.el.inert = !open;
    // Closing moves the cover, not the workbench beneath it. Keep its current
    // layout and visibility until the landing has actually covered the app.
    if (open) panels.setOpen(true);
    if (next !== "tour") fitted = 0;
    const peekPx = applyPeek();
    landing.toggleAttribute("data-lowered", open);
    // Keep the footer out of the app's tab order and scroll range. Restore it
    // before restoring scroll, so an offset at the page bottom is not clamped.
    if (parts.footer) parts.footer.hidden = open;
    // The app uses viewport coordinates; the landing keeps its document offset.
    // Account for that offset in the animation so opening/closing while scrolled
    // (including a reversal in flight) starts at the displayed position.
    window.scrollTo({ top: open ? 0 : landingScroll, behavior: "instant" });
    const fromY = from.m42 + scrollY - previousScroll;
    if (!open) header.setAppState(false);
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
    else if (open) tutorial.clear();
    // An empty tutorial completes synchronously and may already open the app.
    if (own !== revision) return;
    parts.onStage?.(next);

    const to = transformFor(next, peekPx);
    landing.style.transform = to;
    const long = previous === "landing" || next === "landing";
    const duration = reducedMotion() ? 0 : long ? 700 : 380;
    animation = landing.animate([{ transform: `translateY(${fromY}px)` }, { transform: to }], {
      duration,
      easing: ease,
    });
    await animation.finished.catch(() => {});
    if (own !== revision) return;
    animation = null;
    if (next === "tour") refit();
    if (open) panels.setReady(true);
    else {
      tutorial.clear();
      panels.setReady(false);
      panels.setOpen(false);
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
  // A slide marked opensApp opens the app when the deck steps onto it.
  deck.onLaunch = () => open();

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
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && stage === "tour") {
      // The arrows step through the tutorial. Past either end they return to
      // the deck: forwards it continues after the slide that opened the app.
      event.preventDefault();
      const forward = event.key === "ArrowRight";
      if (tutorial.step(forward ? 1 : -1)) return;
      close();
      if (forward && deck.opensApp) deck.step(1);
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
    fitting?.cancel();
    fitting = null;
    fitted = 0;
    landing.style.transform = transformFor(stage, applyPeek());
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
    endTour() {
      tutorial.clear();
      if (stage === "tour") void setStage("app");
    },
    tour() {
      if (stage === "landing") open();
      else if (stage === "tour") tutorial.start();
      else void setStage("tour");
    },
  };
}
