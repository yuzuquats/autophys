import { closePanel, initialPanels, type PanelState, togglePanel, visiblePanels } from "./model.ts";
import type { StatusLine } from "./status.ts";
import type { CookbookSlots } from "./types.ts";
import { Motion } from "./motion.ts";
import { h } from "./dom.ts";

export type Panels = {
  readonly el: HTMLElement;
  /** Empty the three slots and return them, ready for a fresh mount. */
  freshSlots(): CookbookSlots;
  /** The app layer is on screen (the drawer is moving or lowered). */
  setVisible(visible: boolean): void;
  /** Panels slide in from their edges. */
  setOpen(open: boolean): void;
  /** The drawer has settled: the main column fades in and FLIP is allowed. */
  setReady(ready: boolean): void;
  /** Height the lowered deck surface covers at the bottom of the screen. */
  setPeek(px: number): void;
  /** On phones, return from a sheet to the main pane. */
  showMain(): void;
  /** Close a phone sheet; false when none is open. */
  closeSheet(): boolean;
  setStatus(line: StatusLine | null): void;
  reflow(change: () => void): void;
};

const panelGlyph = (x: number) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2.5"/><path d="M${x} 3v14"/></svg>`;

/** The app layer: sidebar (queue slot + status line), main slot, details slot,
 * and the two toggles that dock in the panel headers. */
export function createPanels(options: { scopeId: string; sidebarLabel: string; detailsLabel: string }): Panels {
  const el = h("div", "ck-app", { "data-cookbook": options.scopeId });
  el.inert = true;
  el.innerHTML = `<div class="ck-panels" data-mobile="main">
    <section class="ck-panel ck-sidebar" id="ck-panel-sidebar" role="region" tabindex="-1">
      <div class="ck-panel-header"><h2 class="ck-panel-heading" tabindex="-1"></h2></div>
      <div class="ck-panel-body"><div class="ck-queue"></div><p class="ck-status" role="status" hidden></p></div>
    </section>
    <section class="ck-panel ck-details" id="ck-panel-details" role="region" tabindex="-1">
      <div class="ck-panel-header"><h2 class="ck-panel-heading" tabindex="-1"></h2></div>
      <div class="ck-panel-body"><div class="ck-details-slot"></div></div>
    </section>
    <button type="button" class="ck-toggle ck-sidebar-toggle" aria-controls="ck-panel-sidebar" aria-label="Toggle sidebar">${
    panelGlyph(7.5)
  }</button>
    <button type="button" class="ck-toggle ck-details-toggle" aria-controls="ck-panel-details" aria-label="Toggle details">${
    panelGlyph(12.5)
  }</button>
    <section class="ck-main" aria-label="Main"></section>
  </div>`;
  const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
  const panels = q<HTMLElement>(".ck-panels");
  const sidebar = q<HTMLElement>(".ck-panel.ck-sidebar"), details = q<HTMLElement>(".ck-panel.ck-details");
  sidebar.setAttribute("aria-label", options.sidebarLabel);
  details.setAttribute("aria-label", options.detailsLabel);
  sidebar.querySelector(".ck-panel-heading")!.textContent = options.sidebarLabel;
  details.querySelector(".ck-panel-heading")!.textContent = options.detailsLabel;
  const toggles = {
    sidebar: q<HTMLButtonElement>(".ck-sidebar-toggle"),
    details: q<HTMLButtonElement>(".ck-details-toggle"),
  };
  const slots: CookbookSlots = { queue: q(".ck-queue"), main: q(".ck-main"), details: q(".ck-details-slot") };
  const status = q<HTMLElement>(".ck-status");

  const narrowQuery = matchMedia("(max-width: 760px)");
  const narrow = () => narrowQuery.matches;
  // FLIP the main column's children (whatever the app drew) and the toggles.
  const motion = new Motion(() => [
    ...[...slots.main.children].map((child) => [child, "move"] as const),
    [toggles.sidebar, "move"] as const,
    [toggles.details, "move"] as const,
  ]);
  let state: PanelState = initialPanels;
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
      toggle.inert = !open || (narrow() && state.mobile !== "main" && state.mobile !== which);
    }
    slots.main.inert = !ready || (narrow() && state.mobile !== "main");
  }

  for (const which of ["sidebar", "details"] as const) {
    toggles[which].addEventListener("click", () => {
      motion.reflow(() => {
        state = togglePanel(state, which, narrow());
        sync();
      }, ready && !narrow());
      if (narrow() && state.mobile === which) {
        (which === "sidebar" ? sidebar : details).querySelector<HTMLElement>(".ck-panel-heading")!.focus({
          preventScroll: true,
        });
      }
    });
  }
  narrowQuery.addEventListener("change", () => {
    motion.cancel();
    sync();
  });

  const api: Panels = {
    el,
    freshSlots() {
      motion.cancel();
      for (const slot of Object.values(slots)) slot.replaceChildren();
      return slots;
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
      el.style.setProperty("--ck-peek", `${px}px`);
    },
    showMain() {
      if (!narrow() || state.mobile === "main") return;
      state = { ...state, mobile: "main" };
      sync();
    },
    closeSheet() {
      if (!narrow() || state.mobile === "main") return false;
      const which = state.mobile;
      state = closePanel(state, which, true);
      sync();
      toggles[which].focus({ preventScroll: true });
      return true;
    },
    setStatus(line) {
      status.hidden = !line;
      if (!line) return;
      status.dataset.tone = line.tone;
      status.textContent = line.text;
    },
    reflow(change) {
      motion.reflow(change, ready && !narrow());
    },
  };
  sync();
  return api;
}
