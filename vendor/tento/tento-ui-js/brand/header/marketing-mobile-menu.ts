import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Accordion } from "@tento-ui/components/accordion";
import { Button } from "@tento-ui/components/button/button";
import { IconButton } from "@tento-ui/components/icon-button";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { Hotkeys } from "@tento-ui/hotkeys";
import { SimpleKeyframe } from "@tento-ui/keyframe";
import { ScrollShadows } from "@tento-ui/ui/scroll-shadows";
import { Typography } from "@tento-ui/ui/typography";
import { MenuIcon, XIcon } from "@tento-ui/ui/icons";
import type {
  NavChild,
  NavConfig,
  NavItem,
} from "../blog/blog-design-system";

/**
 * `std-marketing-mobile-menu` — the hamburger trigger shown only at the mobile
 * breakpoint (≤768px, where the desktop nav row is hidden) plus the full-screen
 * modal it opens. The panel lives in this component's shadow tree (not
 * document.body) so it inherits the active brand variant's CSS custom properties
 * through the flattened tree; `position: fixed` still makes it viewport-sized and
 * the header's `overflow: hidden`/sticky context cannot clip it.
 *
 * The panel fills the viewport but sits at a negative z-index inside the sticky
 * header's stacking context, so it paints above all page content yet BEHIND the
 * header's own nav content: the original nav (logo + the trigger, which flips to
 * an X) stays visible on top and is never removed, while the modal still covers
 * the whole screen. Its content — a scrollable nav region (scroll shadows as the
 * affordance) over a pinned "Get started" CTA — is padded down past the header at
 * open time so it clears the floating nav; the CTA is pinned to the bottom, so it
 * is never lost no matter how far the page was scrolled. It slides up 40px and
 * fades in via the simple animation builder (no CSS-transition flash). Only the
 * nav region scrolls.
 */
@component({ name: "std-marketing-mobile-menu" })
export class MarketingMobileMenu extends LonaWebComponent {
  private nav: Option<NavConfig> = null;
  private isOpen: boolean = false;
  private resizeObserver: Option<ResizeObserver> = null;
  // The header we pin to `fixed` while open (see open()), so we can revert it on
  // close.
  private $pinnedHeader: Option<HTMLElement> = null;

  private $panel: HTMLElement = this.$("panel");
  private $scroll: HTMLElement = this.$("scroll");
  private $list: HTMLElement = this.$("list");
  private $cta: HTMLElement = this.$("cta");
  // The round hamburger trigger shown in the header; it flips to an X while the
  // menu is open. The persistent header IS the modal's nav + close control, so
  // there is no separate in-panel close button. Its glyph is nudged off square —
  // see applyTriggerIcon.
  private $trigger: IconButton = IconButton.make();

  constructor() {
    super();
    // The panel fills the viewport but sits at a NEGATIVE z-index inside the
    // sticky header's stacking context: that paints it above all page content
    // (the whole header context is z:10) yet BEHIND the header's own nav content
    // (logo + trigger, painted later in the same context). So the modal fills the
    // screen while the original nav stays visible on top of it and is never
    // removed.
    this.$panel.style.zIndex = "-1";
    this.$("trigger-slot").appendChild(this.$trigger);
    this.applyTriggerIcon(false);

    GESTURE_MANAGER.addPointerEvent(this.$trigger, {
      onClick: () => this.toggle(),
    });
  }

  // Point the trigger at the right icon/label for the current state (hamburger
  // closed, X open). The button keeps its default round background; only the
  // glyph is nudged off the square 32×32 default (0.5px wider, 2px shorter) so it
  // reads balanced inside the circle. Inline width/height on the slotted svg
  // override IconButton's ::slotted sizing.
  private applyTriggerIcon(open: boolean): void {
    this.$trigger.bindIcon(open ? XIcon : MenuIcon, {
      sizePx: 40,
      ariaLabel: open ? "Close menu" : "Open menu",
    });
    const $icon = this.$trigger.firstElementChild;
    if ($icon instanceof SVGElement || $icon instanceof HTMLElement) {
      $icon.style.setProperty("width", "32.5px");
      $icon.style.setProperty("height", "30px");
    }
    this.$trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  static makeWith(nav: NavConfig): MarketingMobileMenu {
    return (MarketingMobileMenu.make() as MarketingMobileMenu).bind(nav);
  }

  bind(nav: NavConfig): this {
    this.nav = nav;

    this.$list.replaceChildren();

    // Items with a mega-menu become accordion rows; flat items (e.g. Pricing)
    // are plain links. The accordion block renders first, then the plain rows —
    // which keeps nav order as long as flat items aren't interleaved before
    // expandable ones (true for the real nav and the all-flat SSR fallback).
    const expandable = nav.items.filter((item) => this.subLinks(item).length > 0);
    const plain = nav.items.filter((item) => this.subLinks(item).length === 0);

    if (expandable.length > 0) {
      this.$list.appendChild(
        Accordion.makeWith({
          items: expandable.map((item) => ({
            header: item.label,
            content: this.$subLinkColumn(item),
          })),
        }),
      );
    }

    for (const item of plain) {
      this.$list.appendChild(this.$plainRow(item));
    }

    this.$cta.replaceChildren();
    if (nav.cta) {
      const cta = nav.cta;
      const $button = Button.makeWith(cta.label, {
        type: "primary",
        onClick: () => {
          this.close();
          if (cta.href != null) this.nav?.onNavigate(cta.href);
        },
      });
      $button.assignStyles({ width: "100%" });
      $button.style.setProperty("--button-padding", "15px 20px");
      $button.style.setProperty("--p-size", "var(--text-13px)");
      this.$cta.appendChild($button);
    }

    return this;
  }

  private subLinks(item: NavItem): NavChild[] {
    if (item.details) {
      const links = item.details.columns.flatMap((column) => column.items);
      if (item.details.footer) links.push(item.details.footer);
      return links;
    }
    return item.children ?? [];
  }

  // Accordion item content: a vertical column of sub-links. This element is
  // appended into the Accordion's shadow tree (it gets `.accordion-content-custom`
  // = flex column), so its children can't be reached by this component's $styles
  // and are styled inline instead.
  private $subLinkColumn(item: NavItem): HTMLElement {
    const $column = document.createElement("div");
    $column.style.gap = "2px";
    for (const child of this.subLinks(item)) {
      $column.appendChild(this.$subLink(child));
    }
    return $column;
  }

  private $subLink(child: NavChild): HTMLElement {
    const $link = document.createElement("button");
    $link.assignStyles({
      display: "flex",
      alignItems: "center",
      width: "100%",
      padding: "10px 0",
      background: "none",
      border: "none",
      cursor: "pointer",
      textAlign: "left",
    });

    const $label = Typography.p(child.label);
    $label.style.setProperty("--font-size", "var(--text-12px)");
    $label.style.setProperty("--margin-top", "0px");
    $label.style.setProperty("--margin-bottom", "0px");
    $label.style.color = "var(--text-sec)";
    $link.appendChild($label);

    GESTURE_MANAGER.addPointerEvent($link, {
      onClick: () => {
        this.close();
        if (child.href != null) this.nav?.onNavigate(child.href);
      },
    });

    return $link;
  }

  private $plainRow(item: NavItem): HTMLElement {
    const $row = document.createElement("button");
    $row.className = "plain-row";
    const $label = document.createElement("p");
    $label.textContent = item.label;
    $row.appendChild($label);

    GESTURE_MANAGER.addPointerEvent($row, {
      onClick: () => {
        this.close();
        if (item.href != null) this.nav?.onNavigate(item.href);
      },
    });

    return $row;
  }

  private toggle(): void {
    this.isOpen ? this.close() : this.open();
  }

  private open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    // Lock page scroll WITHOUT a layout shift. The root reserves a scrollbar lane
    // (`scrollbar-gutter: stable` + `overflow-y: scroll`); the `.brand-menu-open`
    // class removes both that lane and the scrollbar, which would otherwise let the
    // page content slide right. We measure the lane width here (before locking,
    // while it's still reserved) and hand it to the class as a compensating
    // margin-right via a custom property. 0 on overlay-scrollbar platforms — nothing
    // to compensate — so the class is a no-op there.
    const scrollbarComp =
      window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.style.setProperty(
      "--brand-menu-scrollbar-comp",
      scrollbarComp > 0 ? `${scrollbarComp}px` : "0px",
    );
    document.documentElement.classList.add("brand-menu-open");

    // The panel is full-viewport but the header floats on top of it, so pad the
    // content down by the header's height (scroll-independent offsetHeight) — the
    // nav list clears the header instead of hiding behind it. Padding, not
    // positioning, so a stale value only nudges content a few px; the CTA is
    // pinned to the panel bottom regardless and is never lost on scroll.
    const $header = this.closest("std-marketing-header");
    if ($header instanceof HTMLElement) {
      this.$panel.style.paddingTop = `${$header.offsetHeight}px`;
      // Pin the header so the scroll-lock (overflow:hidden, below) can't unstick
      // it: a stuck `position: sticky` header otherwise falls back to static and
      // jumps off-screen when the page was scrolled, taking the logo + X close
      // with it (that was the "buttons gone when scrolled" bug). Fixed holds it
      // at the top; close reverts to sticky at the same top:0, so there's no shift.
      $header.style.position = "fixed";
      $header.style.top = "0px";
      $header.style.left = "0px";
      $header.style.right = "0px";
      this.$pinnedHeader = $header;
    } else {
      this.$panel.style.paddingTop = "0px";
    }

    // Always open scrolled to the top, then sync the scroll-shadow affordance.
    this.$scroll.scrollTop = 0;
    this.$panel.style.visibility = "visible";
    this.$panel.style.pointerEvents = "auto";
    // 40px slide-up + fade in via the simple animation builder (no CSS-transition
    // flash). The panel fills the viewport, so the CTA is always in view
    // regardless of how far the page was scrolled.
    SimpleKeyframe.builder().slideIn(0, 40).fadeIn().animate(this.$panel, true, 240);

    this.applyTriggerIcon(true);
    this.updateScrollShadows();
    Hotkeys.pushEscapeHandler(this, () => this.close());
    // No programmatic focus on open — it triggers the trigger's blue
    // :focus-visible ring. Escape closes via the global handler regardless, and
    // keyboard users still get focus rings when they actually tab.
  }

  private close(animate: boolean = true): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.applyTriggerIcon(false);
    this.unpinHeader();
    Hotkeys.clearEscapeHandler(this);
    document.documentElement.classList.remove("brand-menu-open");
    document.documentElement.style.removeProperty("--brand-menu-scrollbar-comp");

    if (!animate) {
      this.hidePanel();
      return;
    }
    // 40px slide-down + fade out; hide on finish unless we've reopened mid-close.
    SimpleKeyframe.builder()
      .slideOut(0, 40)
      .fadeOut()
      .animate(this.$panel, true, 200, () => this.isOpen, () => this.hidePanel());
  }

  private hidePanel(): void {
    this.$panel.style.visibility = "hidden";
    this.$panel.style.pointerEvents = "none";
    this.$panel.style.opacity = "0";
    this.$panel.style.removeProperty("transform");
  }

  // Revert the header pinned in open() back to its stylesheet `position: sticky`.
  private unpinHeader(): void {
    const $header = this.$pinnedHeader;
    if (!$header) return;
    this.$pinnedHeader = null;
    $header.style.removeProperty("position");
    $header.style.removeProperty("top");
    $header.style.removeProperty("left");
    $header.style.removeProperty("right");
  }

  private updateScrollShadows = (): void => {
    ScrollShadows.updateScrollShadows(this, this.$scroll);
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.$scroll.addEventListener("scroll", this.updateScrollShadows, {
      passive: true,
    });
    // Observe both the scroll container (viewport/orientation resize) and the
    // inner content (the accordion animating open/closed changes its height), so
    // the scroll shadows stay in sync with actual scrollability.
    this.resizeObserver = new ResizeObserver(() => this.updateScrollShadows());
    this.resizeObserver.observe(this.$scroll);
    this.resizeObserver.observe(this.$list);
    this.updateScrollShadows();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.close(false);
    this.$scroll.removeEventListener("scroll", this.updateScrollShadows);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  onRecycle(): void {
    this.close(false);
    this.nav = null;
    this.$list.replaceChildren();
    this.$cta.replaceChildren();
  }

  static $styles = [
    ScrollShadows.$styles,
    css`
      :host {
        display: none;
        align-items: center;
      }

      @media (max-width: 768px) {
        :host {
          display: inline-flex;
        }
      }

      #trigger-slot {
        display: inline-flex;
        --std-icon-button-color: var(--text-sec);
      }

      /* Full-viewport modal: opaque, fills the screen (CTA stays pinned to the
         bottom no matter the page scroll) and slides up + fades in via the
         animation builder — the CSS just holds the closed/hidden resting state.
         The header floats on top (this sits behind it, see the z-index set in the
         constructor); content is padded past the header at open time. The panel
         itself never scrolls (overflow: hidden) — only #scroll does. */
      #panel {
        position: fixed;
        inset: 0;
        background: var(--bg);
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        overflow: hidden;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        --std-icon-button-color: var(--text-sec);
      }

      /* Scrollable middle region. position: relative anchors the scroll shadows;
         min-height: 0 lets this flex child shrink so #scroll can actually scroll. */
      #scroll-shell {
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }

      #scroll {
        position: absolute;
        inset: 0;
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
      }

      #list {
        display: flex;
        flex-direction: column;
        /* Small gap below the floating header (the panel is already padded down
           past it at open time). */
        padding: 12px 20px 8px;
      }

      std-accordion {
        display: block;
        --accordion-header-font-size: var(--text-13px);
        --accordion-header-padding: 16px 4px;
        --accordion-content-padding: 0 8px 14px 36px;
        --accordion-focus-outline: none;
        --accordion-icon-size: 24px;
        --accordion-icon-svg-size: 20px;
      }

      /* Flat items (no mega-menu) — the 36px left pad lines the label up with
         the accordion header labels above (header pad 4 + 24px icon + 8px gap),
         and the top border separates it from the accordion / preceding rows. */
      .plain-row {
        width: 100%;
        display: flex;
        align-items: center;
        padding: 16px 4px 16px 36px;
        background: none;
        border: none;
        border-top: 1px solid var(--divider);
        cursor: pointer;
        text-align: left;
      }

      .plain-row p {
        --font-size: var(--text-14px);
        --line-height-ratio: 1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-pri);
        font-family: inherit;
        font-weight: 500;
      }

      /* Pinned bottom CTA — never scrolls. Even 20px inset, shares the list's 20px
         horizontal rhythm. */
      #cta {
        flex: 0 0 auto;
        padding: 20px;
      }
    `,
  ];

  static $html = html`
    <div id="trigger-slot"></div>
    <div id="panel" role="dialog" aria-modal="true" aria-label="Menu">
      <div id="scroll-shell">
        <div class="scroll-shadow-top"></div>
        <div class="scroll-shadow-bottom"></div>
        <nav id="scroll" aria-label="Site">
          <div id="list"></div>
        </nav>
      </div>
      <div id="cta"></div>
    </div>
  `;
}
