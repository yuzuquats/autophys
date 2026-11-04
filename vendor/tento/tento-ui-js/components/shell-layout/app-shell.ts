import "../rail/rail";
import "../sidebar/sidebar-expand-button";
import "./shell-layout";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Rail } from "../rail/rail";
import { RailState } from "../rail/rail-state";
import { ShellLayout } from "./shell-layout";
import { SidebarExpandButton } from "../sidebar/sidebar-expand-button";
import { Typography } from "../../ui/typography";

// An app's whole chrome in one `bind`: the app bar, the collapsible column,
// the rail standing in it, and where the operator's width and collapse are
// remembered.
//
// WHY THIS EXISTS. `std-shell-layout` is the frame — docked, peek, the mobile
// drawer — and `std-rail` is the column's contents. Three apps sat down
// between them and each wrote the same forty lines to join the two: a geometry
// literal, an expand button wired by hand, a `localStorage` collapse key
// inside a `try`, an app bar with the same five regions, and
// `rail.bind({ title: null, count: null, width: { kind: "frame" }, … })`. Two
// of those files are byte-similar; the third — the ux-tests board — skipped
// `std-shell-layout` entirely and hand-rolled a CSS grid, which is why it is
// the only one of the three with a DRAGGABLE column and the only one with no
// peek and no mobile drawer.
//
// That split is the whole design brief. A shell that only took
// `sidebarWidthPx: number` would have kept the board on its own frame forever,
// so the width here is a choice between a constant and a remembered, dragged
// one, and the resizer is this component's — closing the plan's deferral 13
// (`std-sidebar-container`'s own gutter, which every consumer disables) and
// deferral 14 (frame-hosted resize) together.
//
// WHAT IT DOES NOT OWN. Which row is selected, what the bar's buttons do, and
// what is in the rail: `$rail` is exposed and the caller appends sections,
// trees, a search box or a `slot="foot"` action to it as light children, and
// slots its page as `slot="content"`. A shell that also owned the rail's
// contents would be the "one sidebar with a mode" the plan rejected.

/** Shell defaults. Hoisted above the class for `std-shell-layout`'s reason:
 * an SSR'd element is upgraded during `customElements.define`, which runs
 * field initializers before the namespace block below exists. */
const DEFAULT_MOBILE: AppShell.Mobile = { breakpointPx: 768, sidebarMarginPx: 24 };

@component({ name: "std-app-shell" })
export class AppShell extends LonaWebComponent {
  private $shell: ShellLayout = this.hydrate("shell");
  private $expand: SidebarExpandButton = this.hydrate("expand");
  private $brand: HTMLElement = this.$("brand");
  private $leading: HTMLElement = this.$("leading");
  private $trailing: HTMLElement = this.$("trailing");
  private $subheader: HTMLElement = this.$("subheader");
  private $resizer: HTMLElement = this.$("resizer");

  /** The rail, already frame-hosted and bound. Append your sections, your
   * tree, your search box and your `slot="foot"` action to THIS. */
  readonly $rail: Rail = this.hydrate("rail");

  private props: Option<AppShell.Props> = null;
  private state: RailState.State = { collapsed: false, widthPx: null };
  private resizerBound: boolean = false;
  /** A pending geometry rebind from a drag — see `applyGeometry`. */
  private frame: Option<number> = null;

  constructor() {
    super();
    // The rail's width contract is bound at construction, before any data
    // bind, for `std-rail`'s own reason: a caller may reach for `$rail` and
    // append rows the moment it has the element. `{ kind: "frame" }` always —
    // the column belongs to this shell, and a rail that ALSO kept a width
    // would be the two-width-systems bug the model page rejected. This writes
    // to the SHADOW child, never to the host: a constructor that writes its
    // own attributes throws on `document.createElement`.
    this.$rail.bind({
      title: null,
      count: null,
      width: { kind: "frame" },
      onCollapsedChange: null,
      onWidthChange: null,
    });
    // The expand button's own activation runs through GESTURE_MANAGER, which
    // is a POINTER path: a keyboard Enter or Space on the focused button fires
    // a click with `detail === 0` and nothing was listening for it. Every
    // surface that adopted the button hit this and only the video editor fixed
    // it, in its own file. It belongs here — a control the shell builds is a
    // control the shell has to make work.
    this.$expand.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      this.$expand.onToggleExpanded(this.$expand.toggleAttribute("revealed"));
    });
  }

  bind(props: AppShell.Props): this {
    this.props = props;
    this.$brand.textContent = props.bar.brand;
    this.$brand.toggleAttribute("hidden", props.bar.brand === "");
    AppShell.fill(this.$leading, props.bar.$leading);
    AppShell.fill(this.$trailing, props.bar.$trailing);
    AppShell.fill(this.$subheader, props.$subheader);
    this.$subheader.slot = props.$subheader == null ? "" : "subheader";

    this.toggleAttribute("resizable", props.width.kind === "resizable");
    if (props.width.kind === "resizable" && !this.resizerBound) {
      this.resizerBound = true;
      this.bindResizer();
    }
    this.applyGeometry({ animate: false });
    return this;
  }

  /**
   * Adopt the operator's remembered width and collapse. A call, not a
   * constructor side effect, and not part of `bind` — `std-rail` records why:
   * a constructor that writes attributes throws on `document.createElement`,
   * and a storybook card wants a shell in a KNOWN state rather than whatever
   * state the operator last left the app in.
   */
  restorePreferences(): void {
    const props = this.props;
    if (props == null || props.storagePrefix == null) return;
    const keys = RailState.keys(props.storagePrefix);
    if (props.width.kind === "resizable") {
      this.state.widthPx = RailState.restoreWidth(
        localStorage.getItem(keys.width),
        props.width,
      );
    }
    this.state.collapsed = localStorage.getItem(keys.collapsed) === "true";
    this.applyGeometry({ animate: false });
  }

  collapsed(): boolean {
    return this.state.collapsed;
  }

  setCollapsed(collapsed: boolean, animate: boolean): void {
    if (this.state.collapsed === collapsed) return;
    this.state.collapsed = collapsed;
    this.persist("collapsed", String(collapsed));
    this.applyGeometry({ animate });
    this.props?.onCollapsedChange?.(collapsed);
  }

  closeMobileNav(): void {
    this.$shell.closeMobileNav();
  }

  resetContentScroll(): void {
    this.$shell.resetContentScroll();
  }

  /** The rail body's scroll, for a surface that restores where the reader was
   * after a data bind. Forwarded rather than reached for, because the rail is
   * in THIS shadow tree and the caller cannot see it. */
  get railScrollTop(): number {
    return this.$rail.bodyScrollTop;
  }

  set railScrollTop(px: number) {
    this.$rail.bodyScrollTop = px;
  }

  /** The column's current width in px — what the resizer is dragging and what
   * a content region that measures itself should ask for. */
  widthPx(): number {
    const props = this.props;
    if (props == null) return 0;
    if (props.width.kind === "fixed") return props.width.px;
    return this.state.widthPx ?? props.width.defaultPx;
  }

  /**
   * Push the width and the collapse into `std-shell-layout`.
   *
   * This is the whole of deferral 14: the frame takes a NUMBER, so a remembered
   * or dragged width is expressed by rebinding its geometry. During a drag that
   * rebind is coalesced to one per animation frame — a pointermove can fire
   * several times per frame, and each bind walks the sidebar container's
   * diff-ops, which is work the reader would never see the result of.
   */
  private applyGeometry(options: { animate: boolean }): void {
    const props = this.props;
    if (props == null) return;
    const widthPx = this.widthPx();
    this.style.setProperty("--app-shell-sidebar-w", `${widthPx}px`);
    this.toggleAttribute("collapsed", this.state.collapsed);
    if (!options.animate) this.toggleAttribute("no-transition", true);
    this.$shell.bind({
      geometry: {
        sidebarWidthPx: widthPx,
        mobileBreakpointPx: props.mobile.breakpointPx,
        mobileSidebarMarginPx: props.mobile.sidebarMarginPx,
      },
      expandButton: this.$expand,
      initialSidebarCollapsed: this.state.collapsed,
      // The shell layout's own toggle path — the expand button, and the
      // resize listener that re-reads the breakpoint — reports back here so
      // one place owns the collapse and its persistence. Without this the
      // button would move the column and the storage key would still say
      // otherwise on the next load.
      onSidebarCollapsedChange: (collapsed) => {
        if (this.state.collapsed === collapsed) return;
        this.state.collapsed = collapsed;
        this.persist("collapsed", String(collapsed));
        this.toggleAttribute("collapsed", collapsed);
        props.onCollapsedChange?.(collapsed);
      },
    });
    if (!options.animate) {
      requestAnimationFrame(() => this.toggleAttribute("no-transition", false));
    }
  }

  private scheduleGeometry(): void {
    if (this.frame != null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.applyGeometry({ animate: false });
    });
  }

  private persist(key: "width" | "collapsed", value: string): void {
    const prefix = this.props?.storagePrefix;
    if (prefix == null) return;
    try {
      localStorage.setItem(RailState.keys(prefix)[key], value);
    } catch {
      // Storage can be unavailable (private windows, a shimmed harness). The
      // shell still works for this page's life; only the memory is lost.
    }
  }

  /**
   * The drag on the column's trailing edge, wired once.
   *
   * `RailState.dragWidth` and `restoreWidth` are the same pure functions the
   * rail's own resizer uses, under 22 fixture cases — including the rule that
   * an out-of-bounds stored width is DISCARDED rather than clamped, so a bound
   * that moves does not pin every returning operator to its new edge. Double
   * click resets by deleting the key, never by writing the default back.
   */
  private bindResizer(): void {
    let startWidth = 0;
    let startX = 0;
    GESTURE_MANAGER.addDragGesture(this.$resizer, "std-app-shell-resize", {
      // `onPointerDown` receives the raw PointerEvent; `onPointerMove` the
      // gesture manager's own point bundle — hence `pageX` here, `page.x` below.
      onPointerDown: (e) => {
        startWidth = this.widthPx();
        startX = e.pageX;
        this.toggleAttribute("no-transition", true);
        this.$resizer.toggleAttribute("dragging", true);
      },
      onPointerMove: (e) => {
        const width = this.props?.width;
        if (width == null || width.kind !== "resizable") return;
        this.state.widthPx = RailState.dragWidth(startWidth, e.page.x - startX, width);
        this.scheduleGeometry();
      },
      onPointerUp: () => {
        this.toggleAttribute("no-transition", false);
        this.$resizer.toggleAttribute("dragging", false);
        const px = this.state.widthPx;
        if (px == null) return;
        this.persist("width", String(px));
        this.props?.onWidthChange?.(px);
      },
      onDoubleClick: () => {
        const width = this.props?.width;
        if (width == null || width.kind !== "resizable") return;
        this.state.widthPx = null;
        const prefix = this.props?.storagePrefix;
        if (prefix != null) localStorage.removeItem(RailState.keys(prefix).width);
        this.applyGeometry({ animate: true });
        this.props?.onWidthChange?.(width.defaultPx);
      },
    });
  }

  /** Put one caller-owned element in a bar region, or empty the region. The
   * element is REPLACED rather than appended so a rebind cannot stack two
   * copies of a status line. */
  private static fill($region: HTMLElement, $child: Option<HTMLElement>): void {
    if ($child == null) {
      $region.replaceChildren();
      $region.toggleAttribute("hidden", true);
      return;
    }
    if ($region.firstElementChild !== $child) $region.replaceChildren($child);
    $region.toggleAttribute("hidden", false);
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.state = { collapsed: false, widthPx: null };
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.$leading.replaceChildren();
    this.$trailing.replaceChildren();
    this.$subheader.replaceChildren();
  }

  static makeWith(props: AppShell.Props): AppShell {
    return AppShell.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        /* The shell is the page: it is the scroll boundary, and the safe-area
           inset is applied here rather than by every app that mounts one. */
        position: relative;
        display: block;
        height: 100%;
        box-sizing: border-box;
        padding: var(--tento-safe-area-inset-top) var(--tento-safe-area-inset-right)
          var(--tento-safe-area-inset-bottom) var(--tento-safe-area-inset-left);

        --app-shell-bar-height: 40px;
        --shell-subheader-padding: 0 18px;
      }

      #shell {
        height: 100%;
      }

      /* THE BAR. Five regions in a fixed order — expand, brand, leading,
         spacer, trailing — because that is the order all three surfaces had
         already converged on, and a bar that took a list of elements instead
         would be a <div> with extra steps. Each region hides when it is
         empty, so a surface that uses three of them pays for three. */
      #bar {
        display: flex;
        flex: 0 0 var(--app-shell-bar-height);
        height: var(--app-shell-bar-height);
        min-width: 0;
        align-items: center;
        gap: 8px;
        padding: 0 8px;
        box-sizing: border-box;
        background: var(--bg);
        border-bottom: 1px solid var(--divider);
      }

      /* The brand takes the slack, so it is also the thing that shrinks first
         when the bar runs out of room — the actions and the status keep their
         labels, which is the video editor's rule, restated once here. */
      #brand {
        flex: 1 1 auto;
        min-width: 0;
        margin: 0;
        color: var(--text-sec);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #leading,
      #trailing {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      #brand[hidden],
      #leading[hidden],
      #trailing[hidden] {
        display: none;
      }

      /* THE RESIZER. On the shell rather than inside std-sidebar-container,
         whose own gutter every consumer of the kit disables (deferral 13): the
         container publishes the width, and a component that ALSO dragged it
         would be writing the value it reads. Placed against the host, at the
         column's trailing edge, and 6px wide with a 1px visible line so the
         grab target is bigger than the mark — a 1px target is a 1px target.

         Below the bar, because the bar is full-width: a handle that ran to the
         top of the page would be draggable in a strip that has no column
         under it. */
      #resizer {
        position: absolute;
        top: var(--app-shell-bar-height);
        bottom: 0;
        left: calc(var(--app-shell-sidebar-w, 0px) - 3px);
        width: 6px;
        z-index: 2;
        cursor: col-resize;
        touch-action: none;
        display: none;
      }

      :host([resizable]:not([collapsed])) #resizer {
        display: block;
      }

      /* ...except under the mobile breakpoint, where the column is a modal
         drawer over the content and reserves no space. A drag strip standing
         where the column WOULD be is a strip that resizes nothing, sitting on
         top of the page the reader is actually looking at. std-shell-layout
         puts the "mobile" attribute on itself and the resizer is its next
         sibling here, so this reads that state rather than re-deriving the
         breakpoint. (No backticks in here: this comment lives inside a css
         tagged template, and one would end the literal.) */
      #shell[mobile] ~ #resizer {
        display: none;
      }

      #resizer::after {
        content: "";
        position: absolute;
        inset-block: 0;
        left: 2px;
        width: 2px;
        background: var(--blue);
        opacity: 0;
        transition: opacity 0.12s ease;
      }

      #resizer:hover::after,
      #resizer[dragging]::after {
        opacity: 1;
      }

      /* The column's own transition, suppressed for the restore at boot and
         for the length of a drag — the same escape hatch std-rail uses, and
         for the same reason: a remembered width that ANIMATES to itself on
         every load reads as the page still settling. */
      :host([no-transition]) #shell,
      :host([no-transition]) #resizer {
        transition: none !important;
      }
    `,
  ];

  static $html = html`
    <std-shell-layout id="shell">
      <div id="bar" slot="header">
        <std-sidebar-expand-button id="expand"></std-sidebar-expand-button>
        <p id="brand" class="small"></p>
        <div id="leading"></div>
        <div id="trailing"></div>
      </div>
      <div id="subheader"></div>
      <std-rail id="rail" slot="sidebar"></std-rail>
      <slot name="content" slot="content"></slot>
    </std-shell-layout>
    <div id="resizer"></div>
  `;
}

export namespace AppShell {
  /** The bar's anatomy. Fixed, not a slot bag — see the `#bar` rule. */
  export type Bar = {
    /** The app's name, at the bar's left. `""` draws no label. */
    brand: string;
    /** Between the brand and the spacer — a view switch, a crumb. */
    $leading: Option<HTMLElement>;
    /** Held to the trailing edge — status, counts, icon buttons. */
    $trailing: Option<HTMLElement>;
  };

  /**
   * How wide the column is, and whether the operator may say otherwise.
   *
   * Deliberately NOT `Rail.Width`. That type's `frame` case means "somebody
   * ABOVE me reserved this column" — and above this shell there is nobody, so
   * the distinction it draws is not the one a shell needs. The two questions
   * here are how wide, and (separately, in `storagePrefix`) where that is
   * remembered; folding them into one field is what would have quietly left
   * the two fixed-width surfaces with no remembered collapse, since they have
   * no width to store a prefix alongside.
   */
  export type Width =
    | { kind: "fixed"; px: number }
    | { kind: "resizable"; defaultPx: number; minPx: number; maxPx: number };

  export type Mobile = { breakpointPx: number; sidebarMarginPx: number };

  export type Props = {
    width: Width;
    /**
     * Where the width and the collapse are remembered —
     * `RailState.keys(prefix)`, so a surface moving onto this shell keeps its
     * existing keys and nobody loses a remembered column. `null` remembers
     * nothing, which is what a storybook card wants.
     */
    storagePrefix: Option<string>;
    bar: Bar;
    /** A second line under the bar. `null` leaves the bar a single row. */
    $subheader: Option<HTMLElement>;
    mobile: Mobile;
    onCollapsedChange: Option<(collapsed: boolean) => void>;
    onWidthChange: Option<(px: number) => void>;
  };

  export function defaultMobile(): Mobile {
    return { ...DEFAULT_MOBILE };
  }
}
