import {
  closePanel,
  findItem,
  initialPanels,
  type Item,
  items,
  type PanelState,
  togglePanel,
  visiblePanels,
} from "./model.ts";
import type { HealthLine } from "./health.ts";
import { Motion } from "./motion.ts";
import { h, settleIn } from "./dom.ts";

export type Panels = {
  readonly el: HTMLElement;
  readonly current: Item;
  /** The app layer is on screen (the drawer is moving or lowered). */
  setVisible(visible: boolean): void;
  /** Panels slide in from their edges. */
  setOpen(open: boolean): void;
  /** The drawer has settled: the main area fades in and FLIP is allowed. */
  setReady(ready: boolean): void;
  /** Height the lowered deck surface covers at the bottom of the screen. */
  setPeek(px: number): void;
  select(id: string | null, animate?: boolean): void;
  /** Close a phone sheet; false when none is open. */
  closeSheet(): boolean;
  setHealth(line: HealthLine): void;
  onSelect: ((item: Item) => void) | null;
};

const panelGlyph = (x: number) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2.5"/><path d="M${x} 3v14"/></svg>`;

/** The app: sidebar, main area and details panel. */
export function createPanels(): Panels {
  const el = h("div", "app-layer", { "aria-label": "autophys app" });
  el.inert = true;
  el.innerHTML = `<div class="panels" data-mobile="main">
    <section class="panel sidebar" id="panel-sidebar" role="region" aria-label="Sidebar" tabindex="-1">
      <div class="panel-header"><h2 class="panel-heading" tabindex="-1">Workspace</h2></div>
      <div class="panel-body"><ul class="nav-list"><li class="nav-indicator" aria-hidden="true"></li></ul>
        <p class="health" role="status" data-tone="pending">Checking server…</p></div>
    </section>
    <section class="panel details" id="panel-details" role="region" aria-label="Details" tabindex="-1">
      <div class="panel-header"><h2 class="panel-heading" tabindex="-1">Details</h2></div>
      <div class="panel-body"><div class="detail-content"><h3 class="detail-name"></h3><dl class="facts"></dl></div></div>
    </section>
    <button type="button" class="panel-toggle sidebar-toggle" aria-controls="panel-sidebar" aria-label="Toggle sidebar">${
    panelGlyph(7.5)
  }</button>
    <button type="button" class="panel-toggle details-toggle" aria-controls="panel-details" aria-label="Toggle details">${
    panelGlyph(12.5)
  }</button>
    <section class="main" aria-label="Main">
      <div class="toolbar"><h1 class="main-title"></h1></div>
      <div class="stage"><span class="stage-backdrop" aria-hidden="true"></span><span class="stage-label">autophys</span></div>
    </section>
  </div>`;
  const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
  const panels = q<HTMLElement>(".panels");
  const sidebar = q<HTMLElement>(".panel.sidebar"), details = q<HTMLElement>(".panel.details");
  const toggles = {
    sidebar: q<HTMLButtonElement>(".sidebar-toggle"),
    details: q<HTMLButtonElement>(".details-toggle"),
  };
  const main = q<HTMLElement>(".main"), title = q<HTMLElement>(".main-title");
  const list = q<HTMLUListElement>(".nav-list"), indicator = q<HTMLElement>(".nav-indicator");
  const health = q<HTMLElement>(".health");
  const detailContent = q<HTMLElement>(".detail-content");

  const rows = items.map((item) => {
    const button = h("button", "nav-item", { type: "button", "data-id": item.id }, item.title);
    button.addEventListener("click", () => api.select(item.id, true));
    list.append(h("li", "", null, button));
    return button;
  });

  const narrowQuery = matchMedia("(max-width: 760px)");
  const narrow = () => narrowQuery.matches;
  const motion = new Motion(() => [
    [title, "move"],
    [q(".stage-backdrop"), "box"],
    [q(".stage-label"), "move"],
    [toggles.sidebar, "move"],
    [toggles.details, "move"],
  ]);
  let state: PanelState = initialPanels;
  let current = items[0];
  let open = false, ready = false;

  function sync(): void {
    const visible = visiblePanels(state, narrow());
    panels.dataset.mobile = narrow() ? state.mobile : "main";
    panels.toggleAttribute("data-sidebar", visible.sidebar);
    panels.toggleAttribute("data-details", visible.details);
    for (const [which, panel] of [["sidebar", sidebar], ["details", details]] as const) {
      panel.inert = !open || !visible[which];
      const toggle = toggles[which];
      toggle.setAttribute("aria-pressed", String(visible[which]));
      toggle.setAttribute("aria-expanded", String(visible[which]));
      toggle.title = `${visible[which] ? "Collapse" : "Expand"} ${which}`;
      const covered = narrow() && state.mobile !== "main" && state.mobile !== which;
      toggle.inert = !open || covered;
    }
    main.inert = !ready || (narrow() && state.mobile !== "main");
  }

  function placeIndicator(animate: boolean): void {
    const row = rows[items.indexOf(current)];
    indicator.style.transition = animate ? "" : "none";
    indicator.style.height = `${row.offsetHeight}px`;
    indicator.style.transform = `translateY(${row.parentElement!.offsetTop}px)`;
    if (!animate) void indicator.offsetWidth;
    indicator.style.transition = "";
  }

  for (const which of ["sidebar", "details"] as const) {
    toggles[which].addEventListener("click", () => {
      motion.reflow(() => {
        state = togglePanel(state, which, narrow());
        sync();
      }, ready && !narrow());
      if (narrow() && state.mobile === which) {
        (which === "sidebar" ? sidebar : details).querySelector<HTMLElement>(".panel-heading")!.focus({
          preventScroll: true,
        });
      }
    });
  }
  narrowQuery.addEventListener("change", () => {
    motion.cancel();
    sync();
  });
  new ResizeObserver(() => placeIndicator(false)).observe(list);

  const api: Panels = {
    el,
    get current() {
      return current;
    },
    setVisible(visible) {
      el.toggleAttribute("data-visible", visible);
      el.inert = !visible;
    },
    setOpen(next) {
      open = next;
      panels.toggleAttribute("data-open", next);
      sync();
    },
    setReady(next) {
      ready = next;
      panels.toggleAttribute("data-ready", next);
      sync();
    },
    setPeek(px) {
      el.style.setProperty("--peek", `${px}px`);
    },
    select(id, animate = false) {
      const item = findItem(id);
      const changed = item !== current;
      current = item;
      rows.forEach((row) => row.setAttribute("aria-current", String(row.dataset.id === item.id)));
      placeIndicator(animate && changed);
      title.textContent = item.title;
      detailContent.querySelector(".detail-name")!.textContent = item.title;
      const facts = detailContent.querySelector(".facts")!;
      facts.replaceChildren(
        ...[["ID", item.id], ["Position", `${items.indexOf(item) + 1} of ${items.length}`]].map((
          [label, value],
        ) => h("div", "fact", null, h("dt", "", null, label), h("dd", "", null, value))),
      );
      if (animate && changed) {
        for (const target of [title, q(".stage-label"), detailContent]) settleIn(target);
      }
      if (narrow() && state.mobile === "sidebar") {
        state = { ...state, mobile: "main" };
        sync();
      }
      if (changed || animate) api.onSelect?.(item);
    },
    closeSheet() {
      if (!narrow() || state.mobile === "main") return false;
      const which = state.mobile;
      state = closePanel(state, which, true);
      sync();
      toggles[which].focus({ preventScroll: true });
      return true;
    },
    setHealth(line) {
      health.dataset.tone = line.tone;
      health.textContent = line.text;
    },
    onSelect: null,
  };
  sync();
  api.select(items[0].id);
  return api;
}
