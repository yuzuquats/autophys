import "./rail-section";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { RailSection } from "./rail-section";
import { RailState } from "./rail-state";

// The rail: a head, a scrolling body, a foot, and the width the operator
// dragged it to.
//
// Two rails already owned their width — the commit-review rail and ux-rail —
// with the same 220/300/600 bounds, the same `--rail-w`, the same
// `no-transition` drag and the same double-click reset, under different
// localStorage prefixes. This is that rail once, with the split the review
// rail's header essay names: the rail owns what is true regardless of its
// contents (the width preference, the collapse, the resizer, the head and
// foot regions), and the OWNER keeps what needs to know what the rail points
// at (which row is selected, what a click does, the button that expands a
// collapsed rail).
//
// WHOEVER OWNS THE WIDTH OWNS THE COLLAPSE. A rail hosted by a frame —
// `std-shell-layout`'s sidebar slot, `std-sidebar-container` — has no width
// of its own to keep and no collapse of its own to run: the frame's peek IS
// its collapse, and `setCollapsed` is a no-op. A rail standing in a plain
// flex row has nobody above it, so it keeps the width, the bounds, the keys
// and the collapse itself. `Rail.Width` makes the two cases one prop.
//
// The rail never wraps the frame. One element carrying two width systems —
// the container's `--sidebar-width` written by its diff-ops and the rail's
// `--rail-w` written by the drag — is exactly the stale-copy bug the old
// admin layout had, generalised.
//
// The host is a flex column and the BODY is the scrollport, ux-rail's shape
// rather than the review rail's. The review rail makes its host the
// scrollport so a sticky title is defined against it; that works because its
// resizer lives in the owner. A rail that carries its own resizer needs a
// non-scrolling host edge to hang the handle on, so the scrollport moves one
// level in and the scroll shadows attach to the body.
//
// Collapse defaults to ZERO width, not a lane. A clipped lane pays for its
// 52px only when a glyph column survives the clip — the review rail's graph
// does, a list of names does not, and half a name is noise. The consequence
// is the one thing this component does not own: a zero-width element cannot
// hold its own expand affordance, so the owner places the button (the app
// bar's leading control, `std-sidebar-expand-button`, whatever fits) and asks
// through `setCollapsed`.

@component({ name: "std-rail" })
export class Rail extends LonaWebComponent {
  private $head: HTMLElement = this.$("head");
  private $title: RailSection = this.hydrate("title");
  private $actionsSlot: HTMLSlotElement = this.$("head-actions");
  private $body: HTMLElement = this.$("body");
  private $bodySlot: HTMLSlotElement = this.$("body-slot");
  private $resizer: HTMLElement = this.$("resizer");

  private width: Rail.Width = { kind: "frame" };
  private hasTitle: boolean = false;
  private isCollapsed: boolean = false;
  private resizerBound: boolean = false;
  /** True from the resizer's pointerdown until the drag settles; `moved`
   * once the pointer has actually changed the width. */
  private drag: Option<{ moved: boolean }> = null;
  private onCollapsedChange: Option<(collapsed: boolean) => void> = null;
  private onWidthChange: Option<(px: number) => void> = null;

  constructor() {
    super();
    this.$actionsSlot.addEventListener("slotchange", this.syncHead);
    this.$bodySlot.addEventListener("slotchange", this.scheduleShadowSync);
    this.$body.addEventListener("scroll", this.syncShadows, { passive: true });
  }

  /** Rebind the head and the width contract. Called on boot and whenever the
   * title or count changes; the rows are the owner's, slotted in the light
   * DOM, and are not touched here. */
  bind(props: Rail.Props): this {
    this.width = props.width;
    this.onCollapsedChange = props.onCollapsedChange;
    this.onWidthChange = props.onWidthChange;
    this.hasTitle = props.title != null;
    this.$title.bind({ title: props.title ?? "", count: props.count });
    this.syncHead();

    const owned = props.width.kind === "owned";
    this.toggleAttribute("owned", owned);
    if (props.width.kind === "owned") {
      this.style.setProperty("--rail-default-w", `${props.width.defaultPx}px`);
      this.style.setProperty(
        "--rail-collapsed-w",
        `${props.width.collapsedWidthPx}px`,
      );
      this.toggleAttribute("collapses-to-zero", props.width.collapsedWidthPx === 0);
      if (!this.resizerBound) {
        this.resizerBound = true;
        this.bindResizer();
      }
    } else {
      this.style.removeProperty("--rail-default-w");
      this.style.removeProperty("--rail-collapsed-w");
      this.toggleAttribute("collapses-to-zero", false);
    }
    this.scheduleShadowSync();
    return this;
  }

  /** The count alone, for a rail that re-counts more often than it
   * re-titles. */
  setCount(count: Option<number>): void {
    this.$title.setCount(count);
  }

  collapsed(): boolean {
    return this.isCollapsed;
  }

  /** The body's scroll position. The rail owns the scrollport, so an owner
   * that remembers where the reader was — across a rebuild, or a page
   * reload — asks here rather than reaching into the shadow tree. */
  get bodyScrollTop(): number {
    return this.$body.scrollTop;
  }

  set bodyScrollTop(px: number) {
    this.$body.scrollTop = px;
  }

  /**
   * Collapse to `collapsedWidthPx`, or open. A no-op for a frame-hosted rail:
   * the frame's peek is its collapse, and a rail that also collapsed itself
   * would be two answers to one question.
   *
   * `animate: false` is for the restore at boot — suppressing the transition
   * has to happen BEFORE the basis changes and be lifted a frame later, or a
   * remembered collapse slides shut in front of the reader on every load.
   */
  setCollapsed(collapsed: boolean, animate: boolean): void {
    if (this.width.kind !== "owned") return;
    this.isCollapsed = collapsed;
    if (!animate) this.toggleAttribute("no-transition", true);
    this.toggleAttribute("collapsed", collapsed);
    if (!animate) {
      requestAnimationFrame(() => this.toggleAttribute("no-transition", false));
    }
    Rail.storageSet(
      RailState.keys(this.width.storagePrefix).collapsed,
      String(collapsed),
    );
    this.onCollapsedChange?.(collapsed);
  }

  /**
   * Adopt the operator's remembered width and collapse. A call, not a
   * constructor side effect, for two reasons that agree: a custom element
   * constructor MUST NOT write its own attributes — `document.createElement`
   * throws NotSupportedError the moment it does, which is how the ux-tests
   * board once died at boot — and a caller that wants a rail in a KNOWN state
   * (a storybook card, a test) should not have to fight localStorage to get
   * one. Nothing is restored unless it is asked for. Owned rails only.
   */
  restorePreferences(): void {
    if (this.width.kind !== "owned") return;
    const keys = RailState.keys(this.width.storagePrefix);
    const widthPx = RailState.restoreWidth(
      Rail.storageGet(keys.width),
      this.width,
    );
    if (widthPx != null) this.style.setProperty("--rail-w", `${widthPx}px`);
    this.setCollapsed(Rail.storageGet(keys.collapsed) === "true", false);
  }

  /** The head shows when there is a title or the owner slotted an action;
   * a rail with neither is body and foot only, with no empty band above. */
  private syncHead = (): void => {
    const hasActions = this.$actionsSlot.assignedElements().length > 0;
    this.toggleAttribute("headless", !this.hasTitle && !hasActions);
    this.$title.toggleAttribute("hidden", !this.hasTitle);
  };

  private scheduleShadowSync = (): void => {
    requestAnimationFrame(this.syncShadows);
  };

  /** The scroll shadows are the body's only scroll cue — the bar is hidden,
   * because a gutter reserves 15px inside a 240px column. */
  private syncShadows = (): void => {
    const $b = this.$body;
    this.toggleAttribute("scrolled", $b.scrollTop > 1);
    this.toggleAttribute(
      "more",
      $b.scrollHeight - $b.clientHeight - $b.scrollTop > 1,
    );
  };

  /**
   * The drag on the rail's trailing edge, wired once per element.
   *
   * Width rides a custom property on the HOST so the collapsed rule outranks
   * it untouched rather than fighting it — a collapse must not have to
   * remember and re-apply whatever the operator dragged to. Dragging borrows
   * the collapse animation's own escape hatch (`no-transition`) so the edge
   * tracks the pointer instead of easing after it. Double-click resets by
   * DELETING the property and the key, never by writing the default back.
   * What persists is the MEASURED box, not the last number written: layout
   * gets the final say, and a min-width the rail does not know about can
   * disagree with what the property said. It is measured as the computed
   * `width` — the same box `--rail-w` sets — never the bounding rect, which
   * adds the 1px divider and would grow the rail a pixel per drag and push a
   * drag to the ceiling one past it, where the restore discards it.
   *
   * A drag ends exactly once, in `endDrag`, and not only on the gesture
   * manager's pointer-up: it skips that callback for a cancelled pointer (a
   * touch the browser takes back for scrolling), which would otherwise leave
   * `no-transition` and `dragging` set for good. A press that never moved
   * saves nothing, and neither does a rail removed mid-drag — a detached box
   * measures 0.
   */
  private bindResizer(): void {
    let startWidth = 0;
    let startX = 0;
    GESTURE_MANAGER.addDragGesture(this.$resizer, "std-rail-resize", {
      // `onPointerDown` receives the raw PointerEvent; `onPointerMove` the
      // gesture manager's own point bundle — hence `pageX` here and `page.x`
      // below.
      onPointerDown: (e) => {
        startWidth = this.contentWidthPx();
        startX = e.pageX;
        this.beginDrag();
      },
      onPointerMove: (e) => {
        if (this.width.kind !== "owned" || !this.drag) return;
        const w = RailState.dragWidth(startWidth, e.page.x - startX, this.width);
        this.style.setProperty("--rail-w", `${w}px`);
        this.drag.moved = true;
      },
      onPointerUp: () => this.endDrag(),
      onDoubleClick: () => {
        if (this.width.kind !== "owned") return;
        this.style.removeProperty("--rail-w");
        Rail.storageSet(RailState.keys(this.width.storagePrefix).width, null);
        this.onWidthChange?.(this.width.defaultPx);
      },
    });
  }

  private beginDrag(): void {
    this.endDrag();
    this.drag = { moved: false };
    this.toggleAttribute("no-transition", true);
    this.$resizer.toggleAttribute("dragging", true);
    // Capture phase, registered after the gesture manager's own listeners, so
    // on an ordinary release `onPointerUp` has already run and this is a no-op.
    window.addEventListener("pointerup", this.settleDrag, true);
    window.addEventListener("pointercancel", this.settleDrag, true);
  }

  private settleDrag = (): void => this.endDrag();

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    window.removeEventListener("pointerup", this.settleDrag, true);
    window.removeEventListener("pointercancel", this.settleDrag, true);
    this.toggleAttribute("no-transition", false);
    this.$resizer.toggleAttribute("dragging", false);
    if (this.width.kind !== "owned" || !drag.moved || !this.isConnected) return;
    const w = Math.round(this.contentWidthPx());
    Rail.storageSet(RailState.keys(this.width.storagePrefix).width, String(w));
    this.onWidthChange?.(w);
  }

  private contentWidthPx(): number {
    return parseFloat(getComputedStyle(this).width) || 0;
  }

  // Storage can throw — a sandboxed frame, blocked site data, a full quota —
  // and a preference is never worth a broken rail, so every read and write
  // goes through these and degrades to "nothing remembered".
  private static storageGet(key: string): Option<string> {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private static storageSet(key: string, value: Option<string>): void {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Not remembered; the rail itself is unaffected.
    }
  }

  static $styles = [
    css`
      /* Every default lives on :host and nowhere else. A default declared on
         an inner element would sit BELOW the host in the tree and beat a
         caller's value on the host — the knob would silently stop working.

         --rail-inset is the text inset every row carries (ListCellLayout's own
         8px), matched by every section head under this rail; it is declared
         here so the whole column shares one edge. --rail-bg falls back to the
         page. min-width: 0 is load-bearing: a flex item's default min-width is
         its min-content width, which outranks flex-basis, so without it a long
         row would quietly refuse to let the drag reach the floor — and the
         collapse could never reach zero. */
      :host {
        --rail-inset: 8px;
        --rail-shadow: light-dark(rgb(0 0 0 / 14%), rgb(0 0 0 / 42%));
        position: relative;
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        background: var(--rail-bg, var(--bg));
      }

      /* Frame-hosted: the frame reserved the column; fill it. */
      :host(:not([owned])) {
        flex: 1 1 auto;
        height: 100%;
      }

      /* Owned: the width is ours. The dragged --rail-w when the operator chose
         one, the bound default otherwise. Both flex-basis and width, so the
         rail lays out the same beside a flex sibling and in a plain box. */
      :host([owned]) {
        flex: 0 0 var(--rail-w, var(--rail-default-w, 300px));
        width: var(--rail-w, var(--rail-default-w, 300px));
        border-right: 1px solid var(--divider);
        transition:
          flex-basis 0.22s cubic-bezier(0.2, 0.7, 0.3, 1),
          width 0.22s cubic-bezier(0.2, 0.7, 0.3, 1);
      }

      /* Set for the initial restore so a remembered collapse does not slide
         open on every page load, and while dragging so the edge tracks the
         pointer instead of easing after it. */
      :host([no-transition]) {
        transition: none;
      }

      /* Collapsed: the contents keep their layout and are CLIPPED, never
         reflowed — a rewrap mid-animation reads as a glitch, and a 52px lane
         is meant to show the first 52px of the open rail, not a 52px rail. So
         the head, the body and the foot are pinned to the OPEN width while the
         host narrows over them. */
      :host([owned][collapsed]) {
        flex-basis: var(--rail-collapsed-w, 0px);
        width: var(--rail-collapsed-w, 0px);
        overflow: hidden;
      }

      :host([owned][collapsed]) #head,
      :host([owned][collapsed]) #body-frame,
      :host([owned][collapsed]) ::slotted([slot="foot"]) {
        width: var(--rail-w, var(--rail-default-w, 300px));
        box-sizing: border-box;
      }

      /* A rail collapsed to nothing draws no edge; a 52px lane keeps its
         divider, because it is still a column. */
      :host([collapsed][collapses-to-zero]) {
        border-right: 0;
      }

      /* The insets are std-shell-layout's: its nav wrapper pads 20px 16px, and
         every frame-hosted sidebar (docs, /dev, admin) lays its rows out from
         that edge. An owned rail keeps the same numbers so a rail in a flex
         row and a rail in a shell read as the same column. The body pads its
         rows 16px and the rows inset their text --rail-inset; the title is a
         rail section, which carries that same inset itself, so the head pads
         16px and no more — adding the inset here as well put the title 8px
         right of every section label under it. The band is padded evenly and
         centres its contents, so the title sits in the middle of the head
         rather than on its floor. */
      #head {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 14px 16px;
        background: var(--rail-bg, var(--bg));
      }

      :host([headless]) #head {
        display: none;
      }

      /* The head is a rail section with no rows: the same label register the
         body's sections use, so a rail with a title and a rail whose first
         section names it read identically. */
      #title {
        --rail-section-head-gap: 0px;
        flex: 1 1 auto;
        min-width: 0;
        padding-top: 0;
      }

      #title[hidden] {
        display: none;
      }

      ::slotted([slot="head-actions"]) {
        flex: 0 0 auto;
        margin-left: auto;
      }

      #body-frame {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }

      /* No scrollbar-gutter: it reserves 15px per edge INSIDE the padding,
         which in a 240px rail is 6% of the width and pushes the row text out of
         line with the head. The shadows below are the scroll cue instead. */
      #body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
        scrollbar-width: none;
        padding: var(--rail-body-padding, 0 16px 16px);
        box-sizing: border-box;
      }

      /* No head above it: the body's top inset is the shell's 20px. */
      :host([headless]) #body {
        padding-top: var(--rail-body-padding-top, 20px);
      }

      #body::-webkit-scrollbar {
        width: 0;
        height: 0;
      }

      #shadow-top,
      #shadow-bottom {
        position: absolute;
        left: 0;
        right: 0;
        height: 10px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease-out;
      }

      #shadow-top {
        top: 0;
        background: linear-gradient(var(--rail-shadow), transparent);
      }

      #shadow-bottom {
        bottom: 0;
        background: linear-gradient(transparent, var(--rail-shadow));
      }

      :host([scrolled]) #shadow-top,
      :host([more]) #shadow-bottom {
        opacity: 1;
      }

      ::slotted([slot="foot"]) {
        flex: 0 0 auto;
        background: var(--rail-bg, var(--bg));
      }

      /* The handle sits ON the rail's trailing edge rather than beside it as a
         sibling: absolutely positioned here it is the rail's own edge, and the
         owner lays out two columns rather than three. Owned rails only; a
         frame-hosted rail has no width to drag. */
      #resizer {
        display: none;
        position: absolute;
        top: 0;
        bottom: 0;
        right: -4px;
        width: 7px;
        cursor: col-resize;
        z-index: 3;
        background: transparent;
      }

      :host([owned]) #resizer {
        display: block;
      }

      :host([collapsed]) #resizer {
        display: none;
      }

      #resizer:hover,
      #resizer[dragging] {
        background: linear-gradient(
          to right,
          transparent 2px,
          var(--blue-dimmed) 2px,
          var(--blue-dimmed) 5px,
          transparent 5px
        );
      }

      @media (prefers-reduced-motion: reduce) {
        :host {
          transition: none;
        }
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="head">
      <std-rail-section id="title" hidden></std-rail-section>
      <slot name="head-actions" id="head-actions"></slot>
    </div>
    <div id="body-frame">
      <div id="body"><slot id="body-slot"></slot></div>
      <div id="shadow-top"></div>
      <div id="shadow-bottom"></div>
    </div>
    <slot name="foot"></slot>
    <div id="resizer"></div>
  `;
}

export namespace Rail {
  /** Who owns the width — see `RailState.Width`. */
  export type Width = RailState.Width;

  export type Props = {
    /** The head's identity. `null` for a rail whose body carries its own
     * section heads and needs no title above them. */
    title: Option<string>;
    /** Drawn beside the title; `null` and `0` both omit it. */
    count: Option<number>;
    width: Width;
    onCollapsedChange: Option<(collapsed: boolean) => void>;
    onWidthChange: Option<(px: number) => void>;
  };
}
