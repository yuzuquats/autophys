import type { Deck } from "./deck.ts";
import type { Header } from "./header.ts";
import type { Panels } from "./panels.ts";
import type { Tutorial } from "./tutorial.ts";
import { arrowStage, findItem, type Stage } from "./model.ts";
import { readRoute, routeUrl } from "./route.ts";
import { ease, h, isField, reducedMotion } from "./dom.ts";

/**
 * The landing surface and the app beneath it. The deck sits on one white
 * surface; opening the app lowers that surface to a peek at the bottom of the
 * screen, where the tutorial appears, while the panels slide in from their
 * edges. Finishing the tutorial lowers the surface out of the way. Every move
 * starts from the surface's displayed position, so an interrupted move
 * reverses without a jump.
 *
 * The URL holds the open/closed state (route.ts): opening and closing push
 * history, so Back and Forward retrace them.
 */
export function installDrawer(
  parts: { header: Header; deck: Deck; panels: Panels; tutorial: Tutorial },
): void {
  const { header, deck, panels, tutorial } = parts;
  const landing = h("div", "landing");
  const content = h("div", "landing-content", null, deck.el);
  const tour = h("section", "tour-peek", { "aria-label": "Tutorial" }, tutorial.el);
  tour.inert = true;
  landing.append(content, tour);
  document.body.append(panels.el, landing, header.el);

  let stage: Stage = "landing";
  let revision = 0;
  let animation: Animation | null = null;
  let trigger: HTMLElement | null = null;
  const peek = () => Math.max(0, Math.min(200, innerHeight - 80));
  const transformFor = (s: Stage) =>
    s === "landing"
      ? "translateY(0px)"
      : `translateY(${s === "tour" ? innerHeight - peek() : innerHeight}px)`;

  async function setStage(next: Stage): Promise<void> {
    if (next === stage) return;
    const previous = stage;
    stage = next;
    const own = ++revision;
    const from = getComputedStyle(landing).transform;
    animation?.cancel();
    document.documentElement.dataset.stage = next;
    const open = next !== "landing";
    header.setAppState(open);
    panels.setVisible(true);
    panels.setOpen(open);
    panels.setPeek(next === "tour" ? peek() : 0);
    if (!open) panels.setReady(false);
    landing.toggleAttribute("data-lowered", open);
    content.inert = open;
    tour.inert = next !== "tour";
    if (next === "tour") tutorial.start();
    else tutorial.clear();
    // The deck and the header link are about to go inert. If focus was on
    // them (whatever opened the app), hand it to the way back; a deep link,
    // with nothing focused, moves nothing.
    const active = document.activeElement;
    if (open && previous === "landing" && active && active !== document.body && !panels.el.contains(active)) {
      header.brand.focus({ preventScroll: true });
    }

    const to = transformFor(next);
    landing.style.transform = to;
    const long = previous === "landing" || next === "landing";
    const duration = reducedMotion() ? 0 : long ? 700 : 380;
    animation = landing.animate([{ transform: from === "none" ? "translateY(0px)" : from }, {
      transform: to,
    }], { duration, easing: ease });
    await animation.finished.catch(() => {});
    if (own !== revision) return;
    animation = null;
    if (open) panels.setReady(true);
    else {
      panels.setVisible(false);
      trigger?.focus({ preventScroll: true });
      trigger = null;
    }
  }

  function openApp(item: string | null, push = true): void {
    panels.select(item ?? panels.current.id);
    if (push && stage === "landing") {
      history.pushState({ autophys: "app" }, "", routeUrl({ app: true, item: panels.current.id }));
    }
    if (stage === "landing") void setStage("tour");
  }

  function closeApp(push = true): void {
    if (stage === "landing") return;
    if (push) history.pushState({ autophys: "landing" }, "", "/");
    void setStage("landing");
  }

  panels.onSelect = (item) => {
    header.setCrumb(item.title);
    if (stage !== "landing") {
      history.replaceState({ autophys: "app" }, "", routeUrl({ app: true, item: item.id }));
    }
  };
  header.setCrumb(panels.current.title);
  tutorial.onDone = () => void setStage("app");

  // Any same-origin /app link opens the drawer in place.
  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey ||
      event.altKey
    ) return;
    const link = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link || link.origin !== location.origin) return;
    const route = readRoute(link.pathname);
    if (!route.app) return;
    event.preventDefault();
    trigger = link;
    openApp(route.item);
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
      event.shiftKey
    ) return;
    if (isField(event.target)) return;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && stage === "landing") {
      event.preventDefault();
      deck.step(event.key === "ArrowRight" ? 1 : -1);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.repeat) {
      const next = arrowStage(stage, event.key);
      if (!next) return;
      event.preventDefault();
      if (next === "landing") closeApp();
      else if (stage === "landing") openApp(null);
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
    const route = readRoute(location.pathname);
    if (route.app) {
      panels.select(findItem(route.item).id);
      if (stage === "landing") void setStage("tour");
    } else closeApp(false);
  });

  addEventListener("resize", () => {
    if (animation) return;
    landing.style.transform = transformFor(stage);
    panels.setPeek(stage === "tour" ? peek() : 0);
  });

  document.documentElement.dataset.stage = "landing";
  const initial = readRoute(location.pathname);
  if (initial.app) {
    // Back from an app opened by URL lands on the deck rather than leaving.
    const item = findItem(initial.item).id;
    history.replaceState({ autophys: "landing" }, "", "/");
    history.pushState({ autophys: "app" }, "", routeUrl({ app: true, item }));
    requestAnimationFrame(() => openApp(item, false));
  }
}
