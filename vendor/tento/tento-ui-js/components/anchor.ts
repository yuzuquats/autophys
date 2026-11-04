import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { Style, css } from "../component-styles";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Point } from "@tento-core/point";
import { ScrollAncestorObserver } from "../scroll-utils";
import { ZIndex } from "../z-index";
import { Strategies, Convert } from "../layout-utils";
import {
  OffsetConfig,
  Position,
  resolveOffsets,
  selectOffsetForMode,
  isOverlapPosition,
  convertLayoutSpecToFixed,
} from "../anchor-positioning-utils";
import { Hotkeys } from "../hotkeys";
import { $$ } from "../fastdom";

@component({
  name: "std-anchor",
})
export class Anchor extends LonaWebComponent {
  private static activeDismiss: Option<() => void>;
  private currentConfig: Option<Anchor.Props>;
  private dismissContent: Option<EmptyFunction>;

  private retireContent(): void {
    const dismiss = this.dismissContent;
    this.dismissContent = null;
    dismiss?.();
  }

  onRecycle(): void {
    this.retireContent();
    GESTURE_MANAGER.unregister(this);
    this.currentConfig = null;
    super.onRecycle();
  }

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const rect = this.getBoundingClientRect();
      if (this.currentConfig) {
        this.showContent({ x: rect.left, y: rect.bottom }, this.currentConfig);
      }
    }
  };

  static makeWith($child: HTMLElement, props: Anchor.Props): Anchor {
    const $anchor = Anchor.make();
    $anchor.bind($child, props);
    return $anchor;
  }

  /**
   * Reveals content anchored to an element with automatic positioning and scroll tracking.
   * Returns an AnchorInstance for lifecycle management.
   */
  static reveal(props: Anchor.RevealProps): AnchorInstance {
    const escapeContainer = props.escapeContainer ?? true;
    const container = props.container ?? document.body;
    const position = props.position ?? Position.RIGHT_CENTER;
    const dismissOnClickOutside = props.dismissOnClickOutside ?? true;
    const positionRelativeTo = props.positionRelativeTo ?? "anchor";

    // Resolve offsets using anchor-positioning-utils
    const isOverlap = isOverlapPosition(position);
    const offsets = resolveOffsets({ offset: props.offset });
    const activeOffset = selectOffsetForMode(isOverlap, offsets);

    // Store scroll observer for cleanup
    let scrollObserver: Option<ScrollAncestorObserver> = null;
    let onDismissCallback = props.onDismiss;
    let dismissed = false;
    let appendTask: Option<EmptyFunction>;

    // Create update position callback
    const updatePosition = () => {
      if (dismissed) return;
      const anchorRect = props.$anchor.getBoundingClientRect();
      const contentRect = props.$content.getBoundingClientRect();

      // Determine the reference rect based on positionRelativeTo
      const parentRect =
        positionRelativeTo === "parent"
          ? (
              props.$anchor.parentElement ?? props.$anchor
            ).getBoundingClientRect()
          : anchorRect;

      const layoutSpec = position({
        parentRect: anchorRect,
        contentRect: contentRect,
        marginInlinePx: activeOffset.h,
        marginBlockPx: activeOffset.v,
        scrollTop: window.scrollY,
      });

      if (escapeContainer) {
        // Convert to fixed positioning
        const fixedStyles = convertLayoutSpecToFixed(layoutSpec, anchorRect);
        props.$content.assignStyles({
          position: "fixed",
          zIndex: String(ZIndex.popoverLevel()),
          ...fixedStyles,
        });
      } else {
        // Use absolute positioning within anchor's container
        let finalLayoutSpec = layoutSpec;

        if (positionRelativeTo === "parent") {
          // Existing translation for "parent" mode
          const anchorRectNow = props.$anchor.getBoundingClientRect();
          const parentRectNow = parentRect;

          finalLayoutSpec = presentSides({
            top: layoutSpec.top
              ? `calc(${layoutSpec.top} + ${anchorRectNow.top - parentRectNow.top}px)`
              : layoutSpec.top,
            left: layoutSpec.left
              ? `calc(${layoutSpec.left} + ${anchorRectNow.left - parentRectNow.left}px)`
              : layoutSpec.left,
            right: layoutSpec.right,
            bottom: layoutSpec.bottom,
            transform: layoutSpec.transform,
          });
        } else {
          // Translation for "anchor" mode
          // When positionRelativeTo === "anchor", content is appended to anchor's parent
          // but layoutSpec assumes anchor is the positioned ancestor
          // Need to translate to parent's coordinate space
          const anchorRectNow = props.$anchor.getBoundingClientRect();
          const parentRectNow = (
            props.$anchor.parentElement ?? props.$anchor
          ).getBoundingClientRect();

          const parsePixelValue = (value: string): number => {
            const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
            return match ? Number.parseFloat(match[1]) : 0;
          };

          const translateTop = (value: string | undefined) => {
            if (!value) return value;
            // top: Xpx means X pixels below anchor's top
            // In parent space: anchor.top - parent.top + X
            const px = parsePixelValue(value);
            return `${anchorRectNow.top - parentRectNow.top + px}px`;
          };

          const translateLeft = (value: string | undefined) => {
            if (!value) return value;
            // left: Xpx means X pixels right of anchor's left
            // In parent space: anchor.left - parent.left + X
            const px = parsePixelValue(value);
            return `${anchorRectNow.left - parentRectNow.left + px}px`;
          };

          const translateBottom = (value: string | undefined) => {
            if (!value) return value;

            // Handle calc(100% + Xpx) - means X pixels above anchor's top
            const calcMatch = value.match(
              /calc\(100% \+ (-?\d+(?:\.\d+)?)px\)/,
            );
            if (calcMatch) {
              const offset = Number.parseFloat(calcMatch[1]);
              return `${parentRectNow.bottom - anchorRectNow.top + offset}px`;
            }

            // Handle simple pixel values: Xpx means X pixels above anchor's bottom
            // In parent space: parent.bottom - anchor.bottom + X
            const px = parsePixelValue(value);
            return `${parentRectNow.bottom - anchorRectNow.bottom + px}px`;
          };

          const translateRight = (value: string | undefined) => {
            if (!value) return value;

            // Handle calc(100% + Xpx) - means X pixels left of anchor's left
            const calcMatch = value.match(
              /calc\(100% \+ (-?\d+(?:\.\d+)?)px\)/,
            );
            if (calcMatch) {
              const offset = Number.parseFloat(calcMatch[1]);
              return `${parentRectNow.right - anchorRectNow.left + offset}px`;
            }

            // Handle simple pixel values: Xpx means X pixels left of anchor's right
            // In parent space: parent.right - anchor.right + X
            const px = parsePixelValue(value);
            return `${parentRectNow.right - anchorRectNow.right + px}px`;
          };

          finalLayoutSpec = presentSides({
            top: translateTop(layoutSpec.top),
            left: translateLeft(layoutSpec.left),
            right: translateRight(layoutSpec.right),
            bottom: translateBottom(layoutSpec.bottom),
            transform: layoutSpec.transform,
          });
        }

        props.$content.assignStyles({
          position: "absolute",
          zIndex: String(ZIndex.popoverLevel()),
          ...finalLayoutSpec,
        });
      }
    };

    // Initial positioning
    updatePosition();

    // Append to container
    if (escapeContainer) {
      appendTask = $$.mutate(() => {
        appendTask = null;
        if (dismissed) return;
        container.appendChild(props.$content);
        updatePosition();
      });
    } else {
      // When not escaping, append to container if provided, else to anchor's parent
      const targetContainer =
        container !== document.body
          ? container
          : (props.$anchor.parentElement ?? props.$anchor);
      targetContainer.appendChild(props.$content);
    }

    // Always track scroll for position updates
    scrollObserver = new ScrollAncestorObserver(props.$anchor, updatePosition);
    scrollObserver.observe();

    // Dismiss handler
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (appendTask != null) $$.clear(appendTask);
      appendTask = null;
      scrollObserver?.unobserve();
      scrollObserver = null;
      Hotkeys.clearEscapeHandler(props.$content);
      GESTURE_MANAGER.clearOnClickOutside(props.$content);
      props.$content.parentElement?.removeChild(props.$content);
      const callback = onDismissCallback;
      onDismissCallback = null;
      callback?.();
    };

    // Set up click-outside dismissal
    if (dismissOnClickOutside) {
      GESTURE_MANAGER.toggleCleanUpOnClickOutside(props.$content, dismiss);
    }

    // Set up escape key handler
    Hotkeys.pushEscapeHandler(props.$content, dismiss);

    // Return instance for lifecycle management
    return {
      dismiss,
      updatePosition,
      setOnDismiss: (fn: EmptyFunction) => {
        if (!dismissed) onDismissCallback = fn;
      },
    };
  }

  /**
   * Reveals content at a specific point (x, y) coordinates.
   * Useful for context menus and right-click interactions.
   * Returns an AnchorInstance for lifecycle management.
   */
  static revealAtPoint(props: Anchor.RevealAtPointProps): AnchorInstance {
    // Create an ephemeral anchor element at the specified point
    const $ephemeralAnchor = document.createElement("div");
    $ephemeralAnchor.assignStyles({
      position: "fixed",
      left: props.point.x + "px",
      top: props.point.y + "px",
      width: "1px",
      height: "1px",
      pointerEvents: "none",
      opacity: "0",
    });
    document.body.appendChild($ephemeralAnchor);

    // Layout specs are relative to the anchor, which already sits at the
    // point; the fixed conversion adds the anchor's rect back.
    const positionAtPoint: Anchor.PositionStrategy = () => ({
      top: "0px",
      left: "0px",
    });

    // Delegate to reveal() with the ephemeral anchor
    const instance = Anchor.reveal({
      $anchor: $ephemeralAnchor,
      $content: props.$content,
      position: positionAtPoint,
      offset: props.offset,
      escapeContainer: true, // Always escape for point-based
      container: document.body,
      dismissOnClickOutside: props.dismissOnClickOutside,
      onDismiss: () => {
        $ephemeralAnchor.remove();
        props.onDismiss?.();
      },
    });

    return instance;
  }

  bind($child: HTMLElement, config: Anchor.Props) {
    this.retireContent();
    // Cleanup previous GESTURE_MANAGER handler before rebinding
    GESTURE_MANAGER.unregister(this);

    this.currentConfig = config;
    this.replaceChildren($child);
    const alignToCursor =
      config.alignToCursor != null ? config.alignToCursor : true;

    // Set up accessibility attributes
    this.setAttribute("role", "button");
    this.setAttribute("aria-haspopup", config.ariaHasPopup ?? "dialog");
    this.setAttribute("tabindex", "0");

    // Set up context menu to trigger on both click and right-click
    GESTURE_MANAGER.addPointerEvent(this, {
      onClick: (_capturedElement, offset) => {
        // Convert offset (element-relative) to client (viewport-relative) coordinates
        const rect = this.getBoundingClientRect();
        const clientPoint = alignToCursor
          ? {
              x: rect.left + offset.x,
              y: rect.top + offset.y,
            }
          : {
              x: rect.left,
              y: rect.top + rect.height,
            };
        this.showContent(clientPoint, config);
      },
      onContextMenu: (client, _offset) => {
        this.showContent(client, config);
      },
    });
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback() {
    this.retireContent();
    this.removeEventListener("keydown", this.handleKeydown);
    super.disconnectedCallback();
  }

  private showContent(p: Point, config: Anchor.Props) {
    this.retireContent();
    const result = config.contentProvider(p);
    const initialAnchorRect = this.getBoundingClientRect();
    const clickOffsetX = p.x - initialAnchorRect.left;
    const clickOffsetY = p.y - initialAnchorRect.top;

    const updatePosition = () => {
      const ctx = {
        anchor: Convert.fromDOMRect(this.getBoundingClientRect()),
        content: {
          width: result.$content.offsetWidth || 200,
          height: result.$content.offsetHeight || 100,
        },
        viewport: Convert.viewportRect(),
        margin: Convert.inset(8),
        scrollOffset: { x: 0, y: 0 },
      };

      const layout = Strategies.atPoint({
        x: ctx.anchor.left + clickOffsetX,
        y: ctx.anchor.top + clickOffsetY,
      })(ctx);

      result.$content.assignStyles(Convert.toStyles(layout));
    };

    GESTURE_MANAGER.addPointerEvent(result.$content, {
      onContextMenu: () => {},
      nestedInDrag: true,
    });

    config.context && result.$content.setAttribute("context", config.context);
    Anchor.activeDismiss?.();
    this.toggleAttribute("context-menu-open", true);

    result.$content.assignStyles({
      position: "fixed",
      left: `${p.x}px`,
      top: `${p.y}px`,
      zIndex: String(ZIndex.popoverLevel()),
    });
    document.body.appendChild(result.$content);

    const scrollObserver = new ScrollAncestorObserver(this, updatePosition);
    scrollObserver.observe();

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      scrollObserver.unobserve();
      if (this.dismissContent === dismiss) this.dismissContent = null;
      this.toggleAttribute("context-menu-open", false);
      if (Anchor.activeDismiss === dismiss) {
        Anchor.activeDismiss = null;
      }
      GESTURE_MANAGER.clearOnClickOutside(result.$content);
      GESTURE_MANAGER.unregister(result.$content);
      result.$content.remove();
      result.onDismiss?.();
    };
    this.dismissContent = dismiss;
    Anchor.activeDismiss = dismiss;

    if (result.dismissOnClickOutside !== false) {
      GESTURE_MANAGER.toggleCleanUpOnClickOutside(result.$content, dismiss);
    }
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        position: relative;
        cursor: pointer;
      }

      :host(:focus-visible) {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html = html`
    <slot></slot>
  `;
}

export namespace Anchor {
  export type ContentProvider = (point: Point) => {
    $content: HTMLElement;
    onDismiss?: () => void;
    dismissOnClickOutside?: boolean;
  };

  export type Props = {
    contentProvider: ContentProvider;
    alignToCursor?: Option<boolean>;
    context?: Option<string>;
    ariaHasPopup?: "menu" | "dialog" | "true";
  };

  /**
   * Helper type for menu items (used for building ContextMenus via contentProvider).
   * Preserves the old Item<TId> structure for backward compatibility.
   */
  export type MenuItem<TId = string> = {
    id: TId;
    label: string;
    icon?: Option<string>;
    action?: () => void;
  };

  /**
   * Position strategy - function that generates layout spec
   * Compatible with Position functions from anchor-positioning-utils
   */
  export type PositionStrategy = (params: PositionParams) => LayoutSpec;

  export type PositionParams = {
    marginBlockPx: number;
    marginInlinePx: number;
    parentRect: DOMRect;
    contentRect: DOMRect;
    scrollTop: number;
  };

  export type LayoutSpec = {
    top?: string;
    left?: string;
    right?: string;
    bottom?: string;
    transform?: string;
  };

  /**
   * Props for Anchor.reveal() - all fields (required + optional)
   */
  export type RevealProps = {
    $anchor: HTMLElement;
    $content: HTMLElement;
    position?: Option<PositionStrategy>;
    offset?: Option<OffsetConfig>;
    escapeContainer?: Option<boolean>;
    container?: Option<HTMLElement>;
    dismissOnClickOutside?: Option<boolean>;
    onDismiss?: Option<EmptyFunction>;
    positionRelativeTo?: "anchor" | "parent";
  };

  /**
   * Props for Anchor.revealAtPoint() - all fields
   */
  export type RevealAtPointProps = {
    point: Point;
    $content: HTMLElement;
    offset?: Option<OffsetConfig>;
    dismissOnClickOutside?: Option<boolean>;
    onDismiss?: Option<EmptyFunction>;
  };
}

/**
 * Instance returned by Anchor.reveal() for lifecycle management
 */
export interface AnchorInstance {
  dismiss(): void;
  updatePosition(): void;
  setOnDismiss(fn: EmptyFunction): void;
}

/** A layout spec of the sides that are there (an `undefined` side is left out). */
function presentSides(sides: {
  top: string | undefined;
  left: string | undefined;
  right: string | undefined;
  bottom: string | undefined;
  transform: string | undefined;
}): Anchor.LayoutSpec {
  const spec: Anchor.LayoutSpec = {};
  if (sides.top !== undefined) spec.top = sides.top;
  if (sides.left !== undefined) spec.left = sides.left;
  if (sides.right !== undefined) spec.right = sides.right;
  if (sides.bottom !== undefined) spec.bottom = sides.bottom;
  if (sides.transform !== undefined) spec.transform = sides.transform;
  return spec;
}
