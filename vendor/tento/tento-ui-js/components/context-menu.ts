import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { Style, css } from "../component-styles";
import { Constants } from "@tento-core/constants";
import { $$ } from "../fastdom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Point } from "@tento-core/point";
import { ScrollAncestorObserver } from "../scroll-utils";
import { LonaIcons } from "../ui/icons";
import { Typography } from "../ui/typography";
import { ZIndex } from "../z-index";
import { ListCellLayout } from "./list/list-cell-layout";
import { Position } from "../anchor-positioning-utils";
import { Round } from "./round";
import { Column } from "../component-builtin";

@component({
  name: "std-context-menu-anchor",
})
class ContextMenuAnchor extends LonaWebComponent {
  static makeWith($child: HTMLElement): ContextMenuAnchor {
    const $e = ContextMenuAnchor.make();
    $e.appendChild($child);
    return $e;
  }

  connectedCallback() {
    // Set ARIA attribute indicating this element has a popup menu
    this.setAttribute("aria-haspopup", "menu");
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        height: min-content;
        width: min-content;
        position: relative;
      }
    `,
  ];
  static $html = html`<slot></slot>`;
}

export namespace ContextMenu {
  export const Anchor = ContextMenuAnchor;
  export type Anchor = ContextMenuAnchor;

  let $currentContextMenu: Option<HTMLElement>;
  let currentDismiss: Option<EmptyFunction>;
  let currentScrollObserver: Option<ScrollAncestorObserver>;

  export function builder(
    width?: Option<number>,
    popoverPaddingPx: number = 4,
  ): Builder {
    return new Builder(width, popoverPaddingPx);
  }

  function show(
    $contextMenu: HTMLElement,
    $anchor: HTMLElement,
    cleanup: EmptyFunction,
    position: Position,
    marginInlinePx: number,
    marginBlockPx: number,
    hideOnClickOutside: boolean = true,
  ): () => void {
    if ($currentContextMenu) {
      GESTURE_MANAGER.clearOnClickOutside($currentContextMenu);
      GESTURE_MANAGER.unregister($currentContextMenu);
      $currentContextMenu.remove();
      $currentContextMenu = null;
    }

    // Clean up previous scroll observer
    if (currentScrollObserver) {
      currentScrollObserver.unobserve();
      currentScrollObserver = null;
    }

    // Store initial anchor position and click offset
    const initialAnchorRect = $anchor.getBoundingClientRect();
    let clickOffset: Option<Point>;
    let dismissed = false;
    let scrollObserver: Option<ScrollAncestorObserver> = null;

    const updatePosition = () => {
      if (dismissed) return;
      const anchorRect = $anchor.getBoundingClientRect();
      const spec = position({
        marginBlockPx,
        marginInlinePx,
        parentRect: anchorRect,
        contentRect: $contextMenu.getBoundingClientRect(),
        scrollTop: window.scrollY,
      });

      // If this is a fixed point position (from a click), we need to adjust for scrolling
      if (clickOffset) {
        const scrollDeltaX = anchorRect.left - initialAnchorRect.left;
        const scrollDeltaY = anchorRect.top - initialAnchorRect.top;

        // Adjust the position by the scroll delta
        if (spec.left) {
          const leftValue = Number.parseFloat(spec.left);
          spec.left = leftValue + scrollDeltaX + "px";
        }
        if (spec.top) {
          const topValue = Number.parseFloat(spec.top);
          spec.top = topValue + scrollDeltaY + "px";
        }
      }

      $contextMenu.assignStyles({
        position: "fixed",
        transition: "none",
        top: "",
        left: "",
        right: "",
        bottom: "",
        transform: "",
        ...spec,
        zIndex: String(ZIndex.popoverLevel()),
      });
    };

    // Check if position is from a click (fixedPoint)
    // We can detect this by checking if the position function uses fixed coordinates
    const testSpec = position({
      marginBlockPx: 0,
      marginInlinePx: 0,
      parentRect: {
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
      } as DOMRect,
      contentRect: {
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
      } as DOMRect,
      scrollTop: 0,
    });
    if (testSpec.left && testSpec.top && !testSpec.left.includes("calc")) {
      // This is likely a fixed point position
      clickOffset = {
        x: Number.parseFloat(testSpec.left),
        y: Number.parseFloat(testSpec.top),
      };
    }

    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;

      scrollObserver?.unobserve();
      if (currentScrollObserver === scrollObserver) {
        currentScrollObserver = null;
      }

      GESTURE_MANAGER.clearOnClickOutside($contextMenu);
      GESTURE_MANAGER.unregister($contextMenu);

      if ($currentContextMenu === $contextMenu) {
        $currentContextMenu = null;
      }
      if (currentDismiss === dismiss) {
        currentDismiss = null;
      }

      cleanup();
      $contextMenu.remove();
    };

    hideOnClickOutside &&
      GESTURE_MANAGER.toggleCleanUpOnClickOutside($contextMenu, dismiss);

    document.body.appendChild($contextMenu);
    updatePosition();

    // Set up scroll observer to track anchor movement
    scrollObserver = new ScrollAncestorObserver($anchor, updatePosition);
    currentScrollObserver = scrollObserver;
    scrollObserver.observe();

    $currentContextMenu = $contextMenu;
    return dismiss;
  }

  class Builder {
    private $container: Round;
    private $column: HTMLElement;
    private $menuItems: HTMLElement[] = [];
    private currentFocusIndex: number = -1;
    dismiss: EmptyFunction = Constants.EMPTY_FUNCTION;

    constructor(width?: Option<number>, popoverPaddingPx: number = 4) {
      const $container = Round.makeWith({
        ...Round.Props.MODAL,
        bg: "var(--bg-elevated)",
      });
      $container.setAttribute("role", "menu");
      $container.assignStyles({
        padding: popoverPaddingPx + "px",
        width: (width ?? 200) + "px",
        zIndex: String(ZIndex.popoverLevel()),
        height: "min-content",
        // Focus remains on the menu for Escape and arrow-key navigation, but
        // a menu's current item is already communicated by its hover/active
        // surface; the generic list-cell blue ring is redundant here.
        "--list-cell-layout-focus-outline": "none",
      });

      // Add keyboard navigation for arrow keys
      $container.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.focusNextItem();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this.focusPreviousItem();
        } else if (e.key === "Home") {
          e.preventDefault();
          this.focusItem(0);
        } else if (e.key === "End") {
          e.preventDefault();
          this.focusItem(this.$menuItems.length - 1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.dismiss();
        }
      });
      this.$column = Column.make().assignStyles({
        width: "100%",
      });
      this.$container = $container;
      this.$container.appendChild(this.$column);
    }

    private focusItem(index: number): void {
      if (index < 0 || index >= this.$menuItems.length) return;
      this.currentFocusIndex = index;
      this.$menuItems[index]?.focus();
    }

    private focusNextItem(): void {
      const nextIndex = (this.currentFocusIndex + 1) % this.$menuItems.length;
      this.focusItem(nextIndex);
    }

    private focusPreviousItem(): void {
      const prevIndex =
        (this.currentFocusIndex - 1 + this.$menuItems.length) %
        this.$menuItems.length;
      this.focusItem(prevIndex);
    }

    row($e: HTMLElement): this {
      this.$column.appendChild($e);
      return this;
    }

    cellRow(
      t: string,
      icon: Option<LonaIcons.RawSvg>,
      action: Option<(state: { shouldDismiss: boolean }) => void>,
      iconColor: Option<string> = null,
    ): this {
      const $cell = ListCellLayout.makeWith({
        $icon: icon
          ? LonaIcons.make(icon, {
              color: iconColor,
              margin: "0px 8px 0px 0px",
            })
          : null,
        $content: Typography.p(t, "small").assignStyles({
          "--margin-top": "3px",
          "--margin-bottom": "3px",
        }),
      });

      // Set ARIA role for menu item
      $cell.setAttribute("role", "menuitem");

      if (action) {
        $cell.setAttribute("tabindex", "-1"); // -1 for programmatic focus
        // The list cell suppresses its inner focus ring through the menu's
        // inherited token above. Chromium can still paint a native `auto`
        // outline on the custom-element host, so retire that second ring too.
        $cell.style.outline = "none";
        $cell.addPointerEvent({
          onClick: () => {
            const state = {
              shouldDismiss: true,
            };
            action(state);
            if (state.shouldDismiss) this.dismiss();
          },
        });

        // Enter/Space to activate menu item
        $cell.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const state = { shouldDismiss: true };
            action(state);
            if (state.shouldDismiss) this.dismiss();
          }
        });

        $cell.style.cursor = "pointer";
        this.$menuItems.push($cell);
      } else {
        $cell.setAttribute("aria-disabled", "true");
        $cell.style.setProperty(
          "--list-cell-layout-hover-color",
          "transparent",
        );
        $cell.style.opacity = "0.48";
      }
      this.$column.appendChild($cell);
      return this;
    }

    build(config: { onDismiss: EmptyFunction }): ContextMenu.Built {
      const dismiss = () => {
        config.onDismiss();
        this.$container.parentElement?.removeChild(this.$container);
      };
      this.dismiss = dismiss;
      return Object.assign(this.$container, { dismiss });
    }

    buildAndReveal(
      $target: HTMLElement,
      options?: Optional<{
        position: Position;
        cleanup: EmptyFunction;
        $root: HTMLElement;
        marginInlinePx: number;
        marginBlockPx: number;
        context: string;
        hideOnClickOutside: boolean;
        autoFocus: boolean;
      }>,
    ): ContextMenu.Built {
      if ($currentContextMenu != null) {
        if (currentDismiss) {
          currentDismiss();
        } else {
          GESTURE_MANAGER.clearOnClickOutside($currentContextMenu);
          GESTURE_MANAGER.unregister($currentContextMenu);
          $currentContextMenu.remove();
          $currentContextMenu = null;
        }
      }

      options?.context &&
        this.$container.setAttribute("context", options.context);
      $target.toggleAttribute("context-menu-open", true);
      this.dismiss = show(
        this.$container,
        $target,
        () => {
          $target.toggleAttribute("context-menu-open", false);
          options?.cleanup?.();
        },
        options?.position ?? fixedPoint({ x: 0, y: 0 }),
        options?.marginInlinePx ?? 0,
        options?.marginBlockPx ?? 0,
        options?.hideOnClickOutside ?? true,
      );
      currentDismiss = this.dismiss;

      this.$container.setAttribute("tabindex", "-1");
      this.$container.style.setProperty("outline", "none", "important");
      // Auto-focusing the menu container enables keyboard navigation, but it
      // steals focus from whatever revealed the menu. Callers that reveal a
      // menu while the user is mid-edit in a field (e.g. the date/time field
      // pickers) opt out so the field keeps focus and stays editable.
      if (options?.autoFocus ?? true) {
        $$.mutate(() => {
          this.$container.focus();
          // Round's initial render can clear its inline outline after the
          // menu is revealed. Reassert after focus so Chromium never falls
          // back to its native blue `auto` ring on the container.
          this.$container.style.setProperty("outline", "none", "important");
        });
      }

      return Object.assign(this.$container, {
        dismiss: () => this.dismiss(),
      });
    }
  }

  export type Built = HTMLElement & { dismiss(): void };

  function fixedPoint(p: Point): Position {
    return (_params) => {
      // p is already in viewport coordinates (clientX/clientY)
      // so we can use it directly for fixed positioning
      return {
        top: p.y + "px",
        left: p.x + "px",
      };
    };
  }
}
