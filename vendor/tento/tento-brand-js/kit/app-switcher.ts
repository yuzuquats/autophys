import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";

import { NativeUi } from "@tento-brand/src/native-ui";

// A hover app switcher: a card ("sheet") of sibling apps that grows out from
// behind a home link. Mechanism only -- every colour, radius and shadow is a
// --brand-app-switcher-* custom property the design sets; the fallbacks are
// the UA's system colours, so an unstyled switcher is legible but plain.
//
// The geometry is measured, not offset in CSS. The sheet's inner (padding)
// edge sits exactly one margin above and left of an ANCHOR rect -- by default
// the slotted trigger's box; a host whose trigger art has its own inset (a
// lockup whose tile sits inside a shadow margin) supplies the rect through
// `anchor`. The title row is margin + anchor height + margin, then a
// full-width hairline, then the grid with the same margin on every side. A
// CSS-only offset was 1-2.5px off because borders, subpixel boxes and the
// art's inset all have to agree; measuring on open and on resize keeps them
// agreeing.
//
// At rest the sheet is not rendered (display: none), so it is invisible, not
// hit-testable and hidden from assistive tech; opening fades it in (opacity
// 0 to 1 with a slight scale from the anchor's corner) and closing fades it
// out before it is hidden again. `rest="outline"` adds a resting affordance:
// a hairline drawn exactly on the anchor rect that fades out as the sheet
// fades in, and back as it closes.
//
// Function declarations, not namespace members, for anything a lifecycle
// calls: `@component` upgrades matching elements at class-definition time,
// before a namespace's IIFE has run (see src/app-shell.ts).

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 300;
/**
 * The sheet's fade in and out. Long enough to read as a fade rather than a
 * pop, with a symmetric ease so the opacity ramp is visible from the first
 * frames; the close is a little quicker than the open. The rest outline
 * cross-fades on the open timing.
 */
const FADE_IN_MS = 240;
const FADE_OUT_MS = 200;
const FADE_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/** The most columns the grid uses; fewer when the viewport is narrow or there are fewer apps. */
const MAX_COLUMNS = 4;

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;
}

/**
 * `std-app-switcher`: wraps a slotted trigger (it stays a normal link) and
 * adds a chevron button after it that opens a menu of `apps`.
 *
 * Opening: hover over the trigger or chevron for 150ms (mouse and pen only),
 * a click on the chevron, or Enter / Space / ArrowDown on it (which also
 * focuses the first app). At rest the sheet is not rendered; it fades in on
 * open and out on close (240ms in, 200ms out). Closing: 300ms after the pointer leaves the trigger,
 * chevron and sheet (one region), Escape (focus returns to the chevron), Tab
 * out, a click outside, or a second click on the chevron. Arrow keys, Home
 * and End move between apps. Under `prefers-reduced-motion` the sheet
 * appears and disappears without its fade, and the outline does not fade.
 * Where the pointer can hover, the chevron keeps its space but stays
 * invisible until the switcher is hovered, holds focus or is open; touch
 * screens always show it.
 *
 * Attributes: `current` (the id of the app this page belongs to; its item
 * gets `aria-current="page"`), `label` (the chevron's accessible name,
 * default "Switch app"), `disabled` (no chevron, never opens), and `open`
 * (reflected; setting it before connection opens the sheet once laid out) and
 * `rest` (`outline` draws a hairline exactly on the anchor rect while the
 * sheet is closed; it fades out as the sheet fades in. Absent, or any other
 * value: nothing is drawn at rest).
 * Properties: `apps` and `anchor` (see `AppSwitcher.Props`).
 *
 * Custom properties (all optional): `--brand-app-switcher-margin` (12px),
 * `-sheet`, `-text`, `-border`, `-border-width` (1px), `-hover`, `-current`,
 * `-dot`, `-radius`, `-cell-radius`, `-shadow`, `-layer` (z-index while
 * open, 100), `-cell-width` (84px), `-gap` (4px), `-icon-size` (48px),
 * `-font-size` (12px), `-chevron` (the chevron colour, currentColor),
 * `-outline` (the rest outline's colour, GrayText), `-outline-width` (1px),
 * `-outline-radius` (0).
 * Parts: `root`, `trigger`, `chevron`, `outline`, `sheet`, `title`,
 * `separator`, `grid`, `item`, `icon`, `name`.
 */
@component({ name: "std-app-switcher" })
export class AppSwitcher extends LonaWebComponent {
  static observedAttributes = ["current", "label", "disabled", "open", "rest"];

  private $root = this.$("root");
  private $trigger = this.$("trigger");
  private $chevron = this.$<HTMLButtonElement>("chevron");
  private $sheet = this.$("sheet");
  private $title = this.$("title");
  private $outline = this.$("outline");
  private $grid = this.$("grid");

  private _apps: readonly AppSwitcher.App[] = [];
  /** The host's anchor rect, in viewport coordinates; `null` measures the trigger's box. */
  anchor: Option<() => DOMRectReadOnly> = null;

  /** `hover` closes when the pointer leaves; `pinned` (click, keyboard, `open`) waits for an explicit close. */
  private mode: Option<"hover" | "pinned"> = null;
  // setTimeout's own type: a number in the DOM, a Timeout under deno.ns.
  private openTimer: Option<ReturnType<typeof setTimeout>> = null;
  private closeTimer: Option<ReturnType<typeof setTimeout>> = null;
  private columns = MAX_COLUMNS;
  private reflecting = false;
  /** Re-places the rest outline when the trigger's layout changes. */
  private resizeObserver: Option<ResizeObserver> = null;

  static makeWith(props: AppSwitcher.Props): AppSwitcher {
    return (AppSwitcher.make() as AppSwitcher).bind(props);
  }

  bind(props: AppSwitcher.Props): this {
    this.apps = props.apps;
    if (props.current != null) this.setAttribute("current", props.current);
    else this.removeAttribute("current");
    if (props.label != null) this.setAttribute("label", props.label);
    else this.removeAttribute("label");
    this.anchor = props.anchor ?? null;
    return this;
  }

  get apps(): readonly AppSwitcher.App[] {
    return this._apps;
  }

  set apps(apps: readonly AppSwitcher.App[]) {
    this._apps = apps;
    this.renderItems();
    if (this.isOpen) this.position();
  }

  get isOpen(): boolean {
    return this.mode != null;
  }

  /** Every menu item, in grid order. */
  get items(): HTMLAnchorElement[] {
    return [...this.$grid.querySelectorAll<HTMLAnchorElement>("a[part~=item]")];
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.$root.addEventListener("pointerenter", this.onPointerEnter);
    this.$root.addEventListener("pointerleave", this.onPointerLeave);
    this.$chevron.addEventListener("click", this.onChevronClick);
    this.$chevron.addEventListener("keydown", this.onChevronKey);
    this.$grid.addEventListener("keydown", this.onGridKey);
    this.addEventListener("focusout", this.onFocusOut);
    this.renderChrome();
    if (typeof ResizeObserver === "function") {
      this.resizeObserver ??= new ResizeObserver(() => this.placeOutline());
      this.resizeObserver.observe(this.$root);
    }
    this.placeOutline();
    requestAnimationFrame(() => this.placeOutline());
    if (this.hasAttribute("open") && !this.isOpen) {
      requestAnimationFrame(() => {
        if (this.isConnected && this.hasAttribute("open") && !this.isOpen) this.show();
      });
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.$root.removeEventListener("pointerenter", this.onPointerEnter);
    this.$root.removeEventListener("pointerleave", this.onPointerLeave);
    this.$chevron.removeEventListener("click", this.onChevronClick);
    this.$chevron.removeEventListener("keydown", this.onChevronKey);
    this.$grid.removeEventListener("keydown", this.onGridKey);
    this.removeEventListener("focusout", this.onFocusOut);
    this.resizeObserver?.disconnect();
    this.hide();
    this.finishClose();
  }

  attributeChangedCallback(name: string): void {
    if (name === "open") {
      if (this.reflecting || !this.isConnected) return;
      if (this.hasAttribute("open")) this.show();
      else this.hide();
      return;
    }
    if (name === "current") this.renderItems();
    if (name === "rest") {
      this.placeOutline();
      return;
    }
    this.renderChrome();
    if (name === "disabled" && this.hasAttribute("disabled")) this.hide();
  }

  /** Open the sheet. `focus` moves focus to the first item; `mode` defaults to `pinned`. */
  show(options: { readonly focus?: boolean; readonly mode?: "hover" | "pinned" } = {}): void {
    this.clearTimers();
    if (this.hasAttribute("disabled") || this._apps.length === 0) return;
    const wasOpen = this.isOpen;
    this.mode = options.mode ?? "pinned";
    if (!wasOpen) {
      // A sheet still fading out fades back in from where it is.
      const from = this.$sheet.hidden ? 0 : Number.parseFloat(getComputedStyle(this.$sheet).opacity) || 0;
      for (const animation of this.$sheet.getAnimations()) animation.cancel();
      this.$sheet.hidden = false;
      this.$sheet.inert = false;
      this.$root.removeAttribute("data-closing");
      this.reflect(true);
      this.$chevron.setAttribute("aria-expanded", "true");
      this.position();
      this.animateOpen(from);
      addEventListener("resize", this.onResize);
      document.addEventListener("pointerdown", this.onOutsidePointer, true);
    }
    if (options.focus) this.focusItem(0);
  }

  /** Close the sheet; `restoreFocus` moves focus back to the chevron. */
  hide(options: { readonly restoreFocus?: boolean } = {}): void {
    this.clearTimers();
    if (!this.isOpen) return;
    this.mode = null;
    this.reflect(false);
    this.$chevron.setAttribute("aria-expanded", "false");
    removeEventListener("resize", this.onResize);
    document.removeEventListener("pointerdown", this.onOutsidePointer, true);
    if (options.restoreFocus) this.$chevron.focus();
    this.animateClose();
  }

  /** Re-measure the anchor and place the sheet. Called on open, on resize and when the apps change. */
  position(): void {
    if (!this.isOpen) return;
    const sheetStyle = getComputedStyle(this.$sheet);
    const borderLeft = px(sheetStyle.borderLeftWidth);
    const borderTop = px(sheetStyle.borderTopWidth);
    const borderRight = px(sheetStyle.borderRightWidth);
    const gridStyle = getComputedStyle(this.$grid);
    const margin = px(gridStyle.paddingTop);
    const gap = px(gridStyle.columnGap);
    const cell = this.items[0]?.getBoundingClientRect().width ?? 0;

    const root = this.$root.getBoundingClientRect();
    const anchor = this.anchorRect();
    const left = anchor.left - margin - borderLeft;
    const top = anchor.top - margin - borderTop;

    // Columns: as many as fit between the sheet's left edge and one margin
    // short of the viewport's right edge, at most MAX_COLUMNS.
    const viewport = document.documentElement.clientWidth;
    const room = viewport - left - margin - borderLeft - borderRight - 2 * margin;
    const fit = cell > 0 ? Math.floor((room + gap) / (cell + gap)) : MAX_COLUMNS;
    this.columns = Math.max(1, Math.min(MAX_COLUMNS, this._apps.length, fit));
    this.$grid.style.setProperty("--app-switcher-columns", String(this.columns));

    this.$sheet.style.left = `${left - root.left}px`;
    this.$sheet.style.top = `${top - root.top}px`;
    this.$title.style.height = `${2 * margin + anchor.height}px`;
    // The title row must also hold the chevron, which sits after the trigger.
    const chevron = this.$chevron.getBoundingClientRect();
    this.$sheet.style.minWidth = `${chevron.right + margin - left + borderRight}px`;
    this.$sheet.style.transformOrigin = `${margin + borderLeft}px ${margin + borderTop}px`;
    this.placeOutline();
  }

  /** Lay the rest outline (`rest="outline"`) exactly over the anchor rect. */
  placeOutline(): void {
    if (this.getAttribute("rest") !== "outline" || !this.isConnected) return;
    const root = this.$root.getBoundingClientRect();
    const anchor = this.anchorRect();
    const style = this.$outline.style;
    style.left = `${anchor.left - root.left}px`;
    style.top = `${anchor.top - root.top}px`;
    style.width = `${anchor.width}px`;
    style.height = `${anchor.height}px`;
  }

  /** The anchor rect in viewport coordinates. */
  anchorRect(): DOMRectReadOnly {
    if (this.anchor != null) return this.anchor();
    const slot = this.$trigger.querySelector("slot");
    const target = slot?.assignedElements()[0] ?? this.$trigger;
    return target.getBoundingClientRect();
  }

  private reflect(open: boolean): void {
    this.reflecting = true;
    this.toggleAttribute("open", open);
    this.reflecting = false;
  }

  private animateOpen(from: number): void {
    if (prefersReducedMotion() || typeof this.$sheet.animate !== "function") return;
    this.$sheet.animate(
      [{ opacity: from, transform: `scale(${0.97 + 0.03 * from})` }, { opacity: 1, transform: "none" }],
      { duration: FADE_IN_MS, easing: FADE_EASING },
    );
  }

  /**
   * Fade the sheet out, then stop rendering it. While it fades it is inert
   * (no pointer, no focus) and keeps the open stacking layer.
   */
  private animateClose(): void {
    if (this.$sheet.hidden) return;
    for (const animation of this.$sheet.getAnimations()) animation.cancel();
    if (!this.isConnected || prefersReducedMotion() || typeof this.$sheet.animate !== "function") {
      this.finishClose();
      return;
    }
    this.$sheet.inert = true;
    this.$root.setAttribute("data-closing", "");
    const fade = this.$sheet.animate(
      [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.98)" }],
      { duration: FADE_OUT_MS, easing: FADE_EASING },
    );
    // `finished` rejects when a reopen cancels the fade; the reopen owns the sheet then.
    fade.finished.then(() => this.finishClose(), () => {});
  }

  /** Stop rendering a closed sheet: it is invisible, not hit-testable and hidden from assistive tech. */
  private finishClose(): void {
    if (this.isOpen) return;
    for (const animation of this.$sheet.getAnimations()) animation.cancel();
    this.$sheet.hidden = true;
    this.$sheet.inert = false;
    this.$root.removeAttribute("data-closing");
  }

  private clearTimers(): void {
    if (this.openTimer != null) clearTimeout(this.openTimer);
    if (this.closeTimer != null) clearTimeout(this.closeTimer);
    this.openTimer = null;
    this.closeTimer = null;
  }

  private focusItem(index: number): void {
    const items = this.items;
    if (items.length === 0) return;
    const i = Math.max(0, Math.min(items.length - 1, index));
    for (const [n, item] of items.entries()) item.tabIndex = n === i ? 0 : -1;
    items[i].focus();
  }

  private onPointerEnter = (event: PointerEvent): void => {
    if (event.pointerType === "touch" || this.hasAttribute("disabled")) return;
    if (this.closeTimer != null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.isOpen || this.openTimer != null) return;
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.show({ mode: "hover" });
    }, OPEN_DELAY_MS);
  };

  private onPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;
    if (this.openTimer != null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    if (this.mode !== "hover") return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.mode === "hover") this.hide();
    }, CLOSE_DELAY_MS);
  };

  private onChevronClick = (event: MouseEvent): void => {
    // A hover-opened sheet the reader then clicks stays open: they reached
    // for it. A pinned one closes, so the chevron is also a plain toggle.
    if (this.mode === "pinned") {
      this.hide();
      return;
    }
    // detail 0: the click came from Enter or Space.
    this.show({ mode: "pinned", focus: event.detail === 0 });
  };

  private onChevronKey = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.show({ mode: "pinned", focus: true });
    } else if (event.key === "Escape" && this.isOpen) {
      event.preventDefault();
      this.hide({ restoreFocus: true });
    }
  };

  private onGridKey = (event: KeyboardEvent): void => {
    const items = this.items;
    const at = items.indexOf(event.composedPath().find((n) => n instanceof HTMLAnchorElement) as HTMLAnchorElement);
    const moves: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      ArrowDown: at + this.columns,
      ArrowUp: at - this.columns,
      Home: 0,
      End: items.length - 1,
    };
    if (event.key === "Escape") {
      event.preventDefault();
      this.hide({ restoreFocus: true });
      return;
    }
    const to = moves[event.key];
    if (to == null || at < 0) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && to < 0) {
      this.$chevron.focus();
      return;
    }
    this.focusItem(to);
  };

  private onFocusOut = (event: FocusEvent): void => {
    if (!this.isOpen) return;
    const next = event.relatedTarget as Option<Node>;
    // Focus moving into the shadow tree is retargeted to this element.
    if (next != null && (next === this || this.contains(next) || this.shadowRoot?.contains(next))) return;
    // Focus leaving the document (next == null, e.g. a window switch) keeps a
    // hover sheet's own timer in charge; a pinned sheet closes on Tab out.
    if (next == null && this.mode === "hover") return;
    this.hide();
  };

  private onOutsidePointer = (event: PointerEvent): void => {
    if (event.composedPath().includes(this)) return;
    this.hide();
  };

  private onResize = (): void => this.position();

  private renderChrome(): void {
    this.$chevron.hidden = this.hasAttribute("disabled");
    this.$chevron.setAttribute("aria-label", this.getAttribute("label") ?? "Switch app");
    this.$chevron.setAttribute("aria-expanded", String(this.isOpen));
  }

  private renderItems(): void {
    const current = this.getAttribute("current");
    const items = this._apps.map((app, index) => {
      const item = document.createElement("a");
      item.part.add("item");
      item.setAttribute("role", "menuitem");
      item.tabIndex = index === 0 ? 0 : -1;
      item.href = app.href;
      item.dataset.app = app.id;
      if (app.id === current) item.setAttribute("aria-current", "page");
      const icon = document.createElement("span");
      icon.part.add("icon");
      icon.setAttribute("aria-hidden", "true");
      if (typeof app.icon === "string") {
        // Trusted artwork from the host's own generated assets, never user input.
        icon.innerHTML = app.icon;
      } else {
        icon.append(app.icon());
      }
      const name = document.createElement("span");
      name.part.add("name");
      name.textContent = app.name;
      item.append(icon, name);
      return item;
    });
    this.$grid.replaceChildren(...items);
  }

  static $html = html`
    <div id="root" part="root">
      <span id="trigger" part="trigger"><slot></slot></span>
      <button id="chevron" part="chevron" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="sheet">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M4.5 6.25 8 9.75l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
            stroke-linejoin="round" />
        </svg>
      </button>
      <div id="outline" part="outline" aria-hidden="true"></div>
      <div id="sheet" part="sheet" role="menu" hidden>
        <div id="title" part="title" role="none"></div>
        <div id="separator" part="separator" role="none"></div>
        <div id="grid" part="grid" role="none"></div>
      </div>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: inline-block;
        flex: none;
        min-width: 0;
      }

      #root {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        vertical-align: middle;
      }

      :host([open]) #root,
      #root[data-closing] {
        z-index: var(--brand-app-switcher-layer, 100);
      }

      #trigger {
        position: relative;
        z-index: 2;
        display: block;
        line-height: 0;
      }

      #chevron {
        position: relative;
        z-index: 2;
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: var(--brand-app-switcher-cell-radius, 0);
        background: none;
        color: var(--brand-app-switcher-chevron, currentColor);
        cursor: pointer;
      }

      #chevron[hidden] {
        display: none;
      }

      /* Where a pointer can hover, the chevron keeps its space but stays
        invisible until the switcher is hovered, holds focus or is open.
        Touch screens always show it: it is their only way in. */
      @media (hover: hover) {
        #chevron {
          opacity: 0;
          transition: opacity 120ms ease-out;
        }

        :host(:hover) #chevron,
        :host(:focus-within) #chevron,
        :host([open]) #chevron {
          opacity: 1;
        }
      }

      #chevron:hover {
        background: var(--brand-app-switcher-hover, transparent);
      }

      #chevron:focus-visible {
        outline: 2px solid currentColor;
        outline-offset: 1px;
      }

      #chevron svg {
        width: 16px;
        height: 16px;
        transition: transform 160ms ease-out;
      }

      :host([open]) #chevron svg {
        transform: rotate(180deg);
      }

      /* The rest outline: placed over the anchor rect by placeOutline(). */
      #outline {
        display: none;
        position: absolute;
        z-index: 3;
        box-sizing: border-box;
        border: var(--brand-app-switcher-outline-width, 1px) solid var(--brand-app-switcher-outline, GrayText);
        border-radius: var(--brand-app-switcher-outline-radius, 0);
        pointer-events: none;
        opacity: 1;
        transition: opacity 240ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      :host([rest="outline"]:not([disabled])) #outline {
        display: block;
      }

      :host([open]) #outline {
        opacity: 0;
      }

      /* While rendered, the sheet rests at opacity 0 unless open; the open
        and close fades (animateOpen/animateClose) run over that. */
      #sheet {
        position: absolute;
        z-index: 1;
        left: 0;
        top: 0;
        opacity: 0;
        box-sizing: border-box;
        width: max-content;
        background: var(--brand-app-switcher-sheet, Canvas);
        color: var(--brand-app-switcher-text, CanvasText);
        border: var(--brand-app-switcher-border-width, 1px) solid var(--brand-app-switcher-border, GrayText);
        border-radius: var(--brand-app-switcher-radius, 0);
        box-shadow: var(--brand-app-switcher-shadow, none);
        line-height: normal;
      }

      :host([open]) #sheet {
        opacity: 1;
      }

      #sheet[hidden] {
        display: none;
      }

      #title {
        display: block;
      }

      #separator {
        display: block;
        height: var(--brand-app-switcher-border-width, 1px);
        background: var(--brand-app-switcher-border, GrayText);
      }

      #grid {
        display: grid;
        grid-template-columns: repeat(var(--app-switcher-columns, 4), var(--brand-app-switcher-cell-width, 84px));
        gap: var(--brand-app-switcher-gap, 4px);
        padding: var(--brand-app-switcher-margin, 12px);
      }

      a[part~="item"] {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        min-width: 0;
        padding: 8px 4px 10px;
        border-radius: var(--brand-app-switcher-cell-radius, 0);
        color: inherit;
        text-decoration: none;
        outline: none;
      }

      a[part~="item"]:hover {
        background: var(--brand-app-switcher-hover, transparent);
      }

      a[part~="item"]:focus-visible {
        box-shadow: inset 0 0 0 2px currentColor;
      }

      a[part~="item"][aria-current="page"] {
        background: var(--brand-app-switcher-current, transparent);
      }

      a[part~="item"][aria-current="page"]::after {
        content: "";
        position: absolute;
        top: 8px;
        right: 8px;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--brand-app-switcher-dot, Highlight);
      }

      span[part~="icon"] {
        display: block;
        width: var(--brand-app-switcher-icon-size, 48px);
        height: var(--brand-app-switcher-icon-size, 48px);
        line-height: 0;
      }

      span[part~="icon"] > svg {
        display: block;
        width: 100%;
        height: 100%;
      }

      span[part~="name"] {
        display: block;
        max-width: 100%;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-size: var(--brand-app-switcher-font-size, 12px);
        line-height: 16px;
      }

      @media (prefers-reduced-motion: reduce) {
        #chevron svg,
        #outline {
          transition: none;
        }
      }
    `,
  ];
}

export namespace AppSwitcher {
  export type App = {
    /** Matches `current` for the page's own app. */
    readonly id: string;
    /** The name under the icon. */
    readonly name: string;
    readonly href: string;
    /** Trusted SVG markup (the host's own artwork), or a factory for the icon element. */
    readonly icon: string | (() => Element);
  };
  export type Props = {
    readonly apps: readonly App[];
    readonly current?: Option<string>;
    readonly label?: Option<string>;
    /** The rect the sheet's margins are measured from, in viewport coordinates; default the trigger's box. */
    readonly anchor?: Option<() => DOMRectReadOnly>;
  };
}

/** The switcher's native factory; the trigger is appended by the caller as the element's child. */
export const AppSwitcherUi = NativeUi.define<AppSwitcher, AppSwitcher.Props>({
  component: "app-switcher",
  create: () => AppSwitcher.make() as AppSwitcher,
  bind: (element, props) => element.bind(props),
});
