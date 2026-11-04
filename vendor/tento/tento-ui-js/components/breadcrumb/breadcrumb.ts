import SlashIcon from "@tento-ui/icons/slash.svg";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Position } from "../../anchor-positioning-utils";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { ContextMenu } from "../context-menu";
import { ListCellLayout } from "../list/list-cell-layout";

// Marks the ellipsis the component injects into its own light DOM when it
// collapses an overflowing breadcrumb, so it can be told apart from real crumbs.
const COLLAPSE_ATTR = "data-bc-collapse";
const TRUNCATE_ATTR = "data-bc-truncate";
const ITEM_ACTIONS = new WeakMap<
  HTMLElement,
  ($anchor: HTMLElement) => void
>();

@component({
  name: "std-breadcrumb",
})
export class Breadcrumb extends LonaWebComponent {
  private $slot: HTMLSlotElement = this.$<HTMLSlotElement>("slot");
  private $dividers: HTMLElement = this.$("dividers");

  // Re-fit when our available width changes. We observe OURSELVES — reliable on
  // first layout, font reflow, and window resize (observing the parent misses
  // the breadcrumb's own allocation settling, so the initial collapse never
  // fires). The width-unchanged guard breaks the collapse→resize feedback:
  // collapsing can change our width once, but the collapsed layout is a fixed
  // point, so it settles in a tick instead of oscillating.
  private lastObservedWidth = -1;
  private resizeObserver: ResizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? this.clientWidth;
    if (width === this.lastObservedWidth) return;
    this.lastObservedWidth = width;
    this.updateLayout();
  });
  // Consumer-owned crumbs at the last fit. Injecting/removing our ellipsis
  // fires slotchange too, but crumbItems excludes it; comparing element
  // identity ignores those self-induced changes while still detecting a
  // same-label replacement whose geometry may differ (label → button).
  private lastCrumbItems: HTMLElement[] = [];

  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute("role", "navigation");
    this.setAttribute("aria-label", "Breadcrumb");
    this.resizeObserver.observe(this);
    this.updateLayout();
    this.$slot.addEventListener("slotchange", this.handleSlotChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
    this.$slot.removeEventListener("slotchange", this.handleSlotChange);
  }

  private handleSlotChange = (): void => {
    const items = this.crumbItems();
    const unchanged =
      items.length === this.lastCrumbItems.length &&
      items.every((item, index) => item === this.lastCrumbItems[index]);
    if (unchanged) return;
    this.lastCrumbItems = items;
    this.updateLayout();
  };

  /** Crumbs supplied by the consumer (excludes the ellipsis we inject). */
  private crumbItems(): HTMLElement[] {
    return this.$slot
      .assignedElements()
      .filter((el): el is HTMLElement => !el.hasAttribute(COLLAPSE_ATTR));
  }

  private isOverflowing(): boolean {
    // +1 absorbs sub-pixel rounding. Host is only constrained when a consumer
    // gives it a bounded width (e.g. docs header flex:1 1 auto + min-width:0);
    // unconstrained short breadcrumbs size to content and never overflow.
    // The small size clips on #root as well as the host, and #root is the
    // host's full width, so only #root's scroll width sees the overflow.
    const $root = this.$("root");
    return (
      this.scrollWidth > this.clientWidth + 1 ||
      $root.scrollWidth > $root.clientWidth + 1
    );
  }

  /**
   * Fit the breadcrumb on a single line. When the crumbs overflow the available
   * width, collapse an earlier run into a single "…" while preserving the
   * current (last) crumb, then redraw the dividers between the items that remain
   * visible. Re-runs on resize and whenever the consumer changes the crumbs.
   */
  private updateLayout(): void {
    $$.measure(() => {
      this.querySelector(`[${COLLAPSE_ATTR}]`)?.remove();
      const items = this.crumbItems();
      for (const item of items) {
        item.style.removeProperty("display");
        item.removeAttribute(TRUNCATE_ATTR);
      }

      if (items.length > 1 && this.isOverflowing()) {
        const last = items.length - 1;
        const firstHidden = items.length === 2 ? 0 : 1;
        for (let i = firstHidden; i < last; i++) {
          items[i].style.display = "none";
        }
        // With three or more crumbs, keep the first and last. With two, the
        // first crumb becomes the collapsed run so the current (last) crumb
        // remains visible. Either way the ellipsis sits immediately before
        // the trailing crumbs it precedes.
        const $ellipsis = Breadcrumb.Ellipsis();
        $ellipsis.setAttribute(COLLAPSE_ATTR, "");
        GESTURE_MANAGER.addPointerEvent($ellipsis, {
          // Defer to the next mutate flush so the opening click finishes
          // propagating before the menu registers its click-outside handler;
          // otherwise the very click that opens the flyout is also seen as an
          // outside-click and dismisses it immediately.
          onClick: () =>
            $$.mutate(() => this.showCollapsedFlyout($ellipsis)),
        });
        this.insertBefore($ellipsis, items[firstHidden]);
        if (items.length > 2) {
          // Greedily reveal trailing crumbs while they still fit.
          for (let i = last - 1; i >= 1; i--) {
            items[i].style.removeProperty("display");
            if (this.isOverflowing()) {
              items[i].style.display = "none";
              break;
            }
          }
        }
        // A single very long final crumb can still exceed the space left after
        // collapse. Let that last visible crumb shrink and ellipsize rather
        // than painting over a sibling control outside the breadcrumb.
        if (this.isOverflowing()) items[last].setAttribute(TRUNCATE_ATTR, "");
      } else if (items.length === 1 && this.isOverflowing()) {
        items[0].setAttribute(TRUNCATE_ATTR, "");
      }
      this.drawDividers();
    });
  }

  private drawDividers(): void {
    const items = this.$slot
      .assignedElements()
      .filter((el) => (el as HTMLElement).style.display !== "none");
    DomUtils.clearChildren(this.$dividers);
    const hostRect = this.getBoundingClientRect();

    for (let i = 0; i < items.length - 1; i++) {
      const rect1 = items[i].getBoundingClientRect();
      const rect2 = items[i + 1].getBoundingClientRect();

      const midX = (rect1.right + rect2.left) / 2 - hostRect.left;
      const midY = (rect1.top + rect1.bottom) / 2 - hostRect.top;

      const $divider = document.createElement("div");
      $divider.className = "divider";
      $divider.setAttribute("aria-hidden", "true");
      $divider.innerHTML = SlashIcon;
      $divider.style.left = `${midX}px`;
      $divider.style.top = `${midY}px`;
      this.$dividers.appendChild($divider);
    }
  }

  /** Flyout listing the crumbs hidden by collapse, so they stay reachable. */
  private showCollapsedFlyout($anchor: HTMLElement): void {
    const hidden = this.crumbItems().filter(
      (el) => el.style.display === "none",
    );
    if (hidden.length === 0) return;

    const builder = ContextMenu.builder();
    for (const $crumb of hidden) {
      const label = $crumb.textContent ?? "";
      const itemAction = ITEM_ACTIONS.get($crumb);
      if (itemAction != null) {
        // Re-anchor an interactive hidden crumb's own menu to the visible
        // ellipsis. Waiting for the mutate flush lets this flyout dismiss
        // before the replacement menu registers its click-outside handler.
        builder.cellRow(label, null, () =>
          $$.mutate(() => itemAction($anchor)),
        );
      } else if ($crumb instanceof HTMLAnchorElement) {
        const $link = $crumb;
        builder.cellRow(label, null, () => $link.click());
      } else {
        // Non-navigable crumb (e.g. a section/library label): dimmed, no hover.
        const $content = Typography.p(label, "small").assignStyles({
          "--margin-top": "3px",
          "--margin-bottom": "3px",
          color: "var(--text-sec)",
        });
        const $row = ListCellLayout.makeWith({ $icon: null, $content });
        $row.style.setProperty("--list-cell-layout-hover-color", "transparent");
        builder.row($row);
      }
    }
    // ContextMenu applies the position as `position: fixed`, so it needs a
    // viewport-coordinate POINT. The anchored Position.* constants are
    // bottom/transform-based (for the floating-element system) and render
    // off-screen here — use a fixed point just below the ellipsis, matching how
    // the chat model-menu and other click-opened menus position themselves.
    const rect = $anchor.getBoundingClientRect();
    builder.buildAndReveal($anchor, {
      position: Position.fromPoint({ x: rect.left, y: rect.bottom + 6 }),
    });
  }

  static makeWith(size: Breadcrumb.Size = "large"): Breadcrumb {
    const $breadcrumb = Breadcrumb.make();
    $breadcrumb.setAttribute("size", size);
    return $breadcrumb;
  }

  static $styles = [
    css`
      :host {
        display: inline-flex;
        position: relative;
        max-width: 100%;
        --breadcrumb-item-padding: 6px;
      }

      #root {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        align-items: center;
        gap: 20px;
        min-width: 0;
      }

      :host([size="small"]) {
        overflow: hidden;
        --breadcrumb-item-padding: 4px 8px;
        --p-size: var(--text-9px);
        --h6-size: var(--text-9px);
      }

      /* The floor is an item button's height. Crumbs that are only text
         (a Link and a Label) ride the ramp's trimmed box, which is shorter
         than the glyphs, and this row's clip cut their descenders off. */
      :host([size="small"]) #root {
        gap: 16px;
        width: 100%;
        min-height: 24px;
        overflow: hidden;
      }

      :host([size="small"][unclipped]),
      :host([size="small"][unclipped]) #root {
        overflow: visible;
      }

      /* Crumbs never wrap or shrink — overflow is handled by collapsing the
         middle run to "…" (see updateLayout), not by wrapping to a second line. */
      ::slotted(*) {
        flex: 0 0 auto;
        white-space: nowrap;
      }

      /* Clip the inline axis only. The type ramp's line box is tighter than
         the glyphs, so overflow: hidden cut the descenders off a long label
         ("Campaign" read "Campaian"); clip keeps the ellipsis and lets them
         hang. */
      ::slotted([data-bc-truncate]) {
        flex: 1 1 auto;
        min-width: 0;
        overflow-x: clip;
        overflow-y: visible;
        text-overflow: ellipsis;
      }

      /* Keep a menu trigger visibly selected while its flyout is open.
         ContextMenu sets [context-menu-open] on the anchor; --bg-btn inherits
         through the button's shadow boundary. */
      ::slotted([context-menu-open]) {
        --bg-btn: var(--bg-hover);
      }

      :host([size="small"]) ::slotted([context-menu-open]) {
        --bg-btn: var(--bg-selected);
      }

      #dividers {
        position: absolute;
        inset: 0;
        pointer-events: none;
        align-items: center;
      }

      .divider {
        position: absolute;
        transform: translate(-50%, -50%);
        width: 20px;
        height: 16px;
        color: var(--text-ter);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      :host([size="small"]) .divider {
        width: 16px;
        height: 14px;
      }

      .divider span {
        width: 100%;
        height: 100%;
      }
    `,
  ];

  static $html = html`
    <std-row id="root">
      <slot id="slot"></slot>
    </std-row>
    <std-row id="dividers"></std-row>
  `;
}

export namespace Breadcrumb {
  export type Size = "large" | "small";

  export function Item(
    label: string,
    onClick: Option<($anchor: HTMLElement) => void> = null,
  ): Button {
    // The label rides the type ramp like Label and Link do (class h6), so a
    // small breadcrumb's --h6-size reaches it. Raw text in the button's
    // native <button> took the browser's 13.33px control font instead.
    const $label = document.createElement("span");
    $label.textContent = label;
    $label.classList.add("h6");
    $label.assignStyles({ marginTop: "0px", marginBottom: "0px" });
    const $button = Button.makeWith($label, { type: "flat" });
    ITEM_ACTIONS.delete($button);
    if (onClick != null) {
      ITEM_ACTIONS.set($button, onClick);
      $button.setAttribute("aria-haspopup", "menu");
      GESTURE_MANAGER.addPointerEvent($button, {
        onClick: () => $$.mutate(() => onClick($button)),
      });
    }
    return $button.assignStyles({
      "--button-padding": "var(--breadcrumb-item-padding, 6px)",
      "--fg-btn": "var(--text-pri)",
    });
  }

  export function Ellipsis(): Button {
    return Button.makeWith("...", { type: "flat" }).assignStyles({
      "--button-padding": "var(--breadcrumb-item-padding, 6px)",
      "--fg-btn": "var(--text-ter)",
    });
  }

  export function Link(label: string, href: string): HTMLAnchorElement {
    const $a = document.createElement("a");
    $a.textContent = label;
    $a.href = href;
    $a.assignStyles({
      color: "var(--text-pri)",
      textDecoration: "none",
    });
    $a.classList.add("h6");
    return $a;
  }

  export function Label(label: string): HTMLSpanElement {
    const $span = document.createElement("span");
    $span.textContent = label;
    $span.assignStyles({
      color: "var(--text-ter)",
    });
    $span.classList.add("h6");
    return $span;
  }
}
