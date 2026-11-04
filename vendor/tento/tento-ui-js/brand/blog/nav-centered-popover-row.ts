import { html, LonaWebComponent } from "@tento-ui/component";
import { Column, Row } from "@tento-ui/component-builtin";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Anchor, AnchorInstance } from "@tento-ui/components/anchor";
import { Button } from "@tento-ui/components/button/button";
import { Position } from "@tento-ui/anchor-positioning-utils";
import { Round } from "@tento-ui/components/round";
import { DomUtils } from "@tento-ui/dom";
import { $$ } from "@tento-ui/fastdom";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { SimpleKeyframe } from "@tento-ui/keyframe";
import type { MarketingHeader } from "../header/marketing-header";
import type {
  NavConfig,
  NavDetailsColumn,
  NavDetailsConfig,
  NavItem,
} from "./blog-design-system";
import { BrandNavDetails } from "./brand-nav-details";

@component({ name: "std-nav-centered-popover-row" })
export class NavCenteredPopoverRow extends LonaWebComponent {
  private currentInstance: Option<AnchorInstance> = null;
  private hideTimeout: Option<ReturnType<typeof setTimeout>> = null;
  private activeItem: Option<string> = null;
  private isDismissing: boolean = false;
  private $details: BrandNavDetails = new BrandNavDetails();
  private $popoverContainer: HTMLElement = Column.make();
  private $round: Round;
  private $linksRow: HTMLElement = Row.make();
  private $header: Option<MarketingHeader> = null;
  private resizeObserver: Option<ResizeObserver> = null;
  private appliedOffset: number = 0;
  private linkRefs: Map<string, NavCenteredPopoverRow.LinkRef> = new Map();
  // Controlled selected state, pushed in via setSelected — never derived here.
  // itemHref marks the top-level .nav-current; childHref marks the dropdown .selected.
  private selectedItemHref: Option<string> = null;
  private selectedChildHref: Option<string> = null;
  // The single navigation strategy, pushed in via bind() from NavConfig.onNavigate.
  // Clicking any nav link calls onNavigate(href); items carry only data, no closures.
  private onNavigate: (href: string) => void = () => {};

  constructor() {
    super();

    this.$round = Round.makeWithContent(
      this.$details.$el,
      {
        bg: "var(--bg-elevated)",
        radius: 16,
        shadow: "0 4px 16px rgba(0,0,0,0.2)",
        transformTopLeft: true,
        // Clip the dropdown content to the squircle so the full-bleed gradient
        // wash clips at the rounded corners (Round handles the clipping).
        clip: true,
      },
    );
    this.$popoverContainer.assignStyles({
      maxWidth: "720px",
      width: "100%",
      height: "fit-content",
    });
    this.$popoverContainer.appendChild(this.$round);

    this.$round.addEventListener("pointerenter", () => {
      this.cancelHideTimeout();
    });
    this.$round.addEventListener("pointerleave", () => {
      this.scheduleDismiss();
    });

    this.$linksRow.assignStyles({ alignItems: "center" });
  }

  stylePopover(styles: Record<string, string>): this {
    this.$popoverContainer.assignStyles(styles);
    return this;
  }

  bind(nav: NavConfig, $header: MarketingHeader): this {
    this.$header = $header;
    this.onNavigate = nav.onNavigate;
    this.dismissCurrent(false);

    const desiredLinks: HTMLElement[] = [];
    const desiredKeys = new Set<string>();

    for (let i = 0; i < nav.items.length; i++) {
      const item = nav.items[i];
      const key = `${i}:${item.label}`;
      desiredKeys.add(key);

      let ref = this.linkRefs.get(key);
      if (!ref) {
        const hasDetails =
          item.details != null || (item.children && item.children.length > 0);

        const $link = document.createElement("span");
        $link.className = "brand-nav-link";
        $link.assignStyles({
          cursor: "pointer",
          padding: "6px 12px",
          borderRadius: "6px",
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
        });

        let $chevron: Option<HTMLElement> = null;
        if (hasDetails) {
          $chevron = document.createElement("span");
          $chevron.className = "nav-chevron";
          $chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
          $chevron.assignStyles({
            display: "inline-flex",
            transition: "transform 0.2s ease",
          });
        }

        ref = {
          key,
          $link,
          $chevron,
          item,
        };

        GESTURE_MANAGER.addPointerEvent($link, {
          // Clicking a top-level link navigates (often SPA, so this row survives).
          // Dismiss the open mega-menu + reset the active chevron first, then let
          // the navigation fire. The "selected" affordance is the URL-derived
          // .nav-current class (recomputed on navigation), not a hover residue.
          onClick: () => {
            this.dismissCurrent(false);
            if (ref?.item.href != null) this.onNavigate(ref.item.href);
          },
        });

        $link.addEventListener("pointerenter", () => {
          if (!ref) return;
          const hasDetails =
            ref.item.details != null ||
            (ref.item.children && ref.item.children.length > 0);
          if (!hasDetails) {
            this.dismissCurrent();
            return;
          }

          if (this.currentInstance && this.isDismissing) {
            this.isDismissing = false;
            this.animateReveal();
          }
          if (this.activeItem === ref.key) {
            this.cancelHideTimeout();
            return;
          }

          this.cancelHideTimeout();
          this.rebindDetails(ref.item, ref.key);

          const $anchor = this.$linksRow;
          if (!$anchor) return;

          if (!this.currentInstance) {
            this.$round.setAnimates(false);
            this.currentInstance = Anchor.reveal({
              $anchor,
              $content: this.$popoverContainer,
              position: Position.BOTTOM_CENTER,
              offset: { outer: { vertical: 4, horizontal: 0 } },
              dismissOnClickOutside: false,
              onDismiss: () => {
                this.isDismissing = false;
                this.currentInstance = null;
                this.activeItem = null;
              },
            });
            this.isDismissing = false;
            this.animateReveal();
            $$.mutate(() => this.$round.setAnimates(true));
          }

          this.setActiveChevron(ref.key);
          this.activeItem = ref.key;
        });

        $link.addEventListener("pointerleave", () => {
          this.scheduleDismiss();
        });

        this.linkRefs.set(key, ref);
      }

      ref.item = item;
      ref.$link.textContent = item.label;
      if (ref.$chevron) {
        ref.$link.appendChild(ref.$chevron);
      }
      desiredLinks.push(ref.$link);
    }

    for (const [key] of this.linkRefs) {
      if (desiredKeys.has(key)) continue;
      this.linkRefs.delete(key);
    }

    DomUtils.reconcileChildren(this.$linksRow, desiredLinks);

    const desiredChildren: HTMLElement[] = [this.$linksRow];

    if (nav.cta) {
      const cta = nav.cta;
      const $cta = Button.makeWith(cta.label, { type: "primary" });
      GESTURE_MANAGER.addPointerEvent($cta, {
        onClick: () => {
          if (cta.href != null) this.onNavigate(cta.href);
        },
      });
      desiredChildren.push($cta);
    }

    DomUtils.reconcileChildren(this, desiredChildren);
    $$.mutate(() => this.recenter());

    // Re-apply whatever selection was last pushed in (links were just rebuilt).
    this.applySelectedTopLevel();

    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    $$.mutate(() => this.recenter());
    if (!this.$header) return;
    this.resizeObserver = new ResizeObserver(() => this.recenter());
    this.resizeObserver.observe(this.$header);
  }

  // Controlled entry point: the route→selection is computed outside (selectionForRoute
  // in brand-app/nav-selection.ts) and pushed in. This component only renders it.
  setSelected(sel: { itemHref: Option<string>; childHref: Option<string> }): void {
    this.selectedItemHref = sel.itemHref;
    this.selectedChildHref = sel.childHref;
    this.applySelectedTopLevel();
    // An open menu re-applies the child highlight on its next open; refresh now if
    // one is still open (navigation usually dismisses it first).
    if (this.activeItem != null) {
      const ref = this.linkRefs.get(this.activeItem);
      if (ref) this.rebindDetails(ref.item, ref.key);
    }
  }

  private applySelectedTopLevel(): void {
    for (const [, ref] of this.linkRefs) {
      const isCurrent =
        ref.item.href != null && ref.item.href === this.selectedItemHref;
      ref.$link.classList.toggle("nav-current", isCurrent);
    }
  }

  private recenter() {
    if (!this.$header) return;
    const headerRect = this.$header.getBoundingClientRect();
    if (headerRect.width === 0) return;

    const linksRect = this.$linksRow.getBoundingClientRect();
    const naturalLinksCenter =
      linksRect.left + linksRect.width / 2 - this.appliedOffset;
    const headerCenter = headerRect.left + headerRect.width / 2;
    this.appliedOffset = Math.round(headerCenter - naturalLinksCenter);

    this.$linksRow.style.transform = `translateX(${this.appliedOffset}px)`;
  }

  private rebindDetails(item: NavItem, key: string) {
    const details: NavDetailsConfig = item.details ?? {
      header: null,
      columns: [
        { title: item.label, items: item.children ?? [] },
        { title: "", items: [] },
        { title: "", items: [] },
      ],
      footer: null,
    };

    this.$round.setAnimates(false);
    this.$details.bind(this.makeDetailsContent(details, key));
    $$.mutate(() => this.$round.setAnimates(true));
  }

  private makeDetailsContent(
    details: NavDetailsConfig,
    key: string,
  ): BrandNavDetails.Content {
    const [first, second, third] = details.columns;
    return {
      key,
      header: details.header ?? null,
      columns: [first, second, third],
      footer: details.footer ?? null,
      image: details.image ?? null,
      selectedHref: this.selectedChildHref,
      // Navigating from a dropdown link also dismisses the open menu.
      onNavigate: (href) => {
        this.onNavigate(href);
        this.dismissCurrent();
      },
    };
  }

  private setActiveChevron(activeKey: Option<string>) {
    for (const [, ref] of this.linkRefs) {
      if (!ref.$chevron) continue;
      ref.$chevron.style.transform =
        ref.key === activeKey ? "rotate(180deg)" : "";
    }
  }

  private cancelHideTimeout() {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }

  private scheduleDismiss() {
    this.cancelHideTimeout();
    this.hideTimeout = setTimeout(() => {
      this.dismissCurrent();
    }, 150);
  }

  private dismissCurrent(animate: boolean = true) {
    this.cancelHideTimeout();
    if (!this.currentInstance) return;
    this.setActiveChevron(null);
    const instance = this.currentInstance;
    if (!animate) {
      this.isDismissing = false;
      instance.dismiss();
      this.currentInstance = null;
      this.activeItem = null;
      return;
    }
    if (this.isDismissing) return;
    this.isDismissing = true;
    SimpleKeyframe.builder()
      .slideIn(0, 10)
      .fadeOut()
      .animate(
        this.$round,
        true,
        150,
        () => !this.isDismissing || this.currentInstance !== instance,
        () => {
          if (!this.isDismissing || this.currentInstance !== instance) return;
          instance.dismiss();
          this.currentInstance = null;
          this.activeItem = null;
          this.isDismissing = false;
        },
      );
  }

  private animateReveal() {
    SimpleKeyframe.builder()
      .slideOut(0, 10)
      .fadeIn()
      .animate(this.$round, true, 150);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.dismissCurrent(false);
  }

  static $html: Option<HTMLTemplateElement> = html`<slot></slot>`;
  static $styles = [
    css`
      :host {
        display: contents;
      }
    `,
  ];
}

export namespace NavCenteredPopoverRow {
  export type LinkRef = {
    key: string;
    $link: HTMLElement;
    $chevron: Option<HTMLElement>;
    item: NavItem;
  };
}
