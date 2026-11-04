import "../sidebar/sidebar-container";
import "../sidebar/sidebar-expand-button";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { CSSLength } from "../../css-length";
import {
  SidebarContainer,
  SidebarContainerState,
} from "../sidebar/sidebar-container";
import { SidebarExpandButton } from "../sidebar/sidebar-expand-button";

// Hoisted above the class: the SSR'd <std-shell-layout> is upgraded synchronously
// during `customElements.define`, which runs instance field initializers BEFORE
// the `export namespace ShellLayout {...}` block below executes. Referencing a
// namespace function from a field initializer would throw at that point.
const DEFAULT_SHELL_GEOMETRY: ShellLayout.Geometry = {
  sidebarWidthPx: 320,
  mobileBreakpointPx: 768,
  mobileSidebarMarginPx: 24,
};

/**
 * A generic app-shell skeleton: a header row, an optional breadcrumb sub-header
 * on a second line, and a collapsible sidebar splitting a nav column from the
 * content. Every region is a **slot** (`header` / `subheader` / `sidebar` /
 * `content`) so surfaces compose their own chrome and content — docs surfaces
 * slot `std-docs-nav` + `std-documentation`, the tento fleet shell slots its
 * nav + an iframe.
 *
 * This component owns ONLY layout + responsive sidebar behavior (docked on
 * desktop, hover-peek when collapsed, modal drawer on mobile) and the
 * expand-button wiring. Nav binding, breadcrumb building, and content loading
 * are the consumer's job (see `docs-shell.ts` for the docs orchestration).
 */
@component({
  name: "std-shell-layout",
})
export class ShellLayout extends LonaWebComponent {
  private $sidebar: SidebarContainer = this.hydrate("sidebar");
  private $contentWrapper: HTMLElement = this.$("content-wrapper");
  private $subheaderSlot: HTMLSlotElement = this.$("subheader-slot");

  private geometry: ShellLayout.Geometry = DEFAULT_SHELL_GEOMETRY;
  private $expandButton: Option<SidebarExpandButton> = null;
  private mobileNavOpen: boolean = false;
  private sidebarCollapsed: boolean = false;

  constructor() {
    super();
    // Reveal the breadcrumb sub-header bar only when a surface actually slots a
    // breadcrumb into it (surfaces that keep the breadcrumb inline in their
    // header leave the bar empty/hidden).
    this.$subheaderSlot.addEventListener("slotchange", this.syncSubheader);
    this.syncSubheader();
  }

  // `window` outlives this component, so the resize listener is the opposite
  // case from the slot listener above: it MUST be removed on detach, or a
  // pooled instance keeps reacting to resizes forever — which means it must
  // also be installed on attach, not in the constructor, or reuse gets a
  // component that has been removed once and never re-added.
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.handleResize);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("resize", this.handleResize);
  }

  private syncSubheader = (): void => {
    this.toggleAttribute(
      "has-subheader",
      this.$subheaderSlot.assignedElements().length > 0,
    );
  };

  bind(props: ShellLayout.Props): this {
    this.geometry = props.geometry;
    this.$expandButton = props.expandButton;
    this.sidebarCollapsed = props.initialSidebarCollapsed ?? false;

    if (this.$expandButton != null) {
      this.$expandButton.onToggleExpanded = (expanded) => {
        if (this.isMobileLayout()) {
          this.mobileNavOpen = expanded;
        } else {
          this.sidebarCollapsed = !expanded;
          props.onSidebarCollapsedChange?.(this.sidebarCollapsed);
        }
        this.syncSidebarLayout({ animate: true });
      };
    }

    this.syncSubheader();
    this.syncSidebarLayout({ animate: false });
    return this;
  }

  /** Close the mobile nav drawer (used by consumers after SPA navigation). */
  closeMobileNav(): void {
    if (!this.isMobileLayout()) return;
    this.mobileNavOpen = false;
    this.syncSidebarLayout({ animate: true });
  }

  /** The scrolling content viewport, for read-only overlays and measurements. */
  get contentViewport(): HTMLElement { return this.$contentWrapper; }

  /** Scroll the content region back to the top (e.g. after a content swap).
   * The content-wrapper lives in shadow DOM, so consumers can't reach it. */
  resetContentScroll(): void {
    this.$contentWrapper.scrollTop = 0;
  }

  private handleResize = (): void => {
    this.syncSidebarLayout({ animate: false });
  };

  private isMobileLayout(): boolean {
    return window.innerWidth <= this.geometry.mobileBreakpointPx;
  }

  private resolveSidebarWidth(): CSSLength {
    if (!this.isMobileLayout()) {
      return CSSLength.fromPx(this.geometry.sidebarWidthPx);
    }
    const maxWidthPx = Math.max(
      0,
      window.innerWidth - this.geometry.mobileSidebarMarginPx,
    );
    return CSSLength.fromPx(Math.min(this.geometry.sidebarWidthPx, maxWidthPx));
  }

  /** Whether the sidebar is currently shown (docked on desktop / open drawer on mobile). */
  private sidebarShown(): boolean {
    return this.isMobileLayout() ? this.mobileNavOpen : !this.sidebarCollapsed;
  }

  private syncSidebarButton(): void {
    this.$expandButton?.toggleAttribute("revealed", this.sidebarShown());
  }

  private syncSidebarLayout(options: { animate: boolean }): void {
    const mobile = this.isMobileLayout();
    if (!mobile) {
      this.mobileNavOpen = false;
    }
    this.toggleAttribute("mobile", mobile);
    // `docked` drives main-content width independently of the sidebar's width
    // diff-op (which doesn't fire on a docked<->peek toggle since width is
    // unchanged). Only a docked sidebar reserves horizontal space.
    this.toggleAttribute("docked", !mobile && !this.sidebarCollapsed);

    const width = this.resolveSidebarWidth();
    // Reserve the docked column before descendants measure themselves. The
    // sidebar applies its own paint/animation styles in a later fastdom batch.
    this.style.setProperty("--shell-sidebar-width", width.resolve());
    const animate = options.animate;
    const viewModel = mobile
      ? SidebarContainerState.modal({
          width,
          animate,
          open: this.mobileNavOpen,
          backdrop: "dim",
          dismissOnBackdrop: true,
          dismissOnEscape: true,
          resizeEnabled: false,
        })
      : this.sidebarCollapsed
        ? SidebarContainerState.peek({
            width,
            animate,
            resizeEnabled: false,
          })
        : SidebarContainerState.docked({
            width,
            animate,
            resizeEnabled: false,
          });

    this.$sidebar.bind({
      viewModel,
      delegate: {
        onRequestModalClose: () => {
          if (!this.mobileNavOpen) return;
          this.mobileNavOpen = false;
          this.syncSidebarLayout({ animate: true });
        },
      },
    });
    this.syncSidebarButton();
  }

  static $styles = [
    css`
      :host {
        display: block;
        min-height: 0;
      }

      #root {
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        min-height: 0;
      }

      /* Breadcrumb sub-header: a second line below the header slot. Hidden until
         a surface slots a breadcrumb into it. The divider above it is the
         header's own border-bottom; this bar owns the divider below it,
         separating the header block from the scrolling content. */
      #subheader {
        display: none;
        flex: 0 0 auto;
        align-items: center;
        box-sizing: border-box;
        min-height: var(--shell-subheader-min-height, 0px);
        padding: var(--shell-subheader-padding, 8px 40px);
        border-bottom: 1px solid var(--divider);
        background: var(--bg);
      }

      :host([has-subheader]) #subheader {
        display: flex;
      }

      ::slotted([slot="subheader"]) {
        flex: 1 1 auto;
        min-width: 0;
        /* Breadcrumb here is secondary chrome on its own line — a step smaller
           than the .h6 default (lowering the token the crumbs resolve through). */
        --h6-size: var(--text-11px);
      }

      #sidebar {
        flex: 1 1 auto;
        min-height: 0;
        --sidebar-container-border-radius: 0px;
      }

      #nav-wrapper {
        height: 100%;
        overflow-y: auto;
        /* The nav and the content are separate reading surfaces: flicking one
           to its end must not hand the leftover delta to the other (or to the
           document, which rubber-bands the whole shell). Contain, not none:
           each surface keeps its own bounce, it just stops there. */
        overscroll-behavior: contain;
        box-sizing: border-box;
        padding: var(--shell-nav-padding, 20px 16px);
      }

      /* Divider between the docked sidebar and content. Peek reveals as an
         overlay strip and the mobile drawer carries its own border, so the
         divider is scoped to the docked desktop state. */
      :host([docked]) #nav-wrapper {
        border-right: 1px solid var(--divider);
      }

      :host([mobile]) #nav-wrapper {
        width: var(--shell-sidebar-width, 320px);
        max-width: calc(100vw - 24px);
        background: var(--bg);
        border-right: 1px solid var(--divider);
      }

      #content-wrapper {
        width: 100%;
        height: 100%;
        overflow-y: auto;
        /* Also the last stop for a framed miniapp's own overscroll, which
           chains out through the iframe into this document. */
        overscroll-behavior: contain;
        /* stable keeps centred content still when a page's length brings its
           scrollbar in or out (classic, always-visible scrollbars). */
        scrollbar-gutter: var(--shell-content-scrollbar-gutter, auto);
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      :host([docked]) #content-wrapper {
        width: calc(100vw - var(--shell-sidebar-width, 0px));
      }

      /* The content slot grows to fill the column; the slotted content (docs
         view or iframe) fills it and picks up optional max-width/padding. */
      #content-wrapper slot[name="content"] {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }

      ::slotted([slot="content"]) {
        flex-grow: 1;
        min-width: 0;
        box-sizing: border-box;
        max-width: var(--shell-content-max-width, none);
        padding: var(--shell-content-padding, 0px);
      }
    `,
  ];

  static $html = html`
    <std-col id="root">
      <slot name="header"></slot>
      <div id="subheader"><slot name="subheader" id="subheader-slot"></slot></div>
      <std-sidebar-container id="sidebar">
        <div id="nav-wrapper" slot="sidebar"><slot name="sidebar"></slot></div>
        <div id="content-wrapper" slot="main-content">
          <slot name="content"></slot>
          <slot name="content-footer"></slot>
        </div>
      </std-sidebar-container>
    </std-col>
  `;
}

export namespace ShellLayout {
  export type Geometry = {
    sidebarWidthPx: number;
    mobileBreakpointPx: number;
    mobileSidebarMarginPx: number;
  };

  export type Props = {
    geometry: Geometry;
    expandButton: Option<SidebarExpandButton>;
    initialSidebarCollapsed?: Option<boolean>;
    onSidebarCollapsedChange?: Option<(collapsed: boolean) => void>;
  };

  export function defaultGeometry(): Geometry {
    return { ...DEFAULT_SHELL_GEOMETRY };
  }
}
