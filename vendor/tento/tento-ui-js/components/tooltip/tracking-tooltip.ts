import { $$ } from "../../fastdom";
import { ScrollAncestorObserver } from "../../scroll-utils";
import { ZIndex } from "../../z-index";

export namespace TrackingTooltip {
  export type Position = "right" | "left" | "top" | "bottom" | "right-top";

  let $currentTooltip: Option<HTMLElement>;
  let currentScrollObserver: Option<ScrollAncestorObserver>;
  let currentCleanup: Option<EmptyFunction>;

  export function show(
    text: string,
    $anchor: HTMLElement,
    position: Position = "right",
    marginPx: number = 8,
  ): () => void {
    // Clean up any existing tooltip
    hide();

    // Create tooltip element
    const $tooltip = document.createElement("div");
    $tooltip.className = "tracking-tooltip";
    $tooltip.textContent = text;

    // Apply base styles
    $tooltip.assignStyles({
      position: "fixed",
      background: "#222",
      color: "white",
      padding: "4px 12px",
      borderRadius: "5px",
      fontSize: "0.775rem",
      fontWeight: "normal",
      lineHeight: "initial",
      zIndex: String(ZIndex.TOOLTIP),
      pointerEvents: "none",
      userSelect: "none",
      maxWidth: "240px",
      whiteSpace: "normal",
      wordWrap: "break-word",
      opacity: "0",
      transition: "opacity 0.15s ease",
    });

    const updatePosition = () => {
      const anchorRect = $anchor.getBoundingClientRect();
      let top: number;
      let left: number;

      switch (position) {
        case "right":
          top = anchorRect.top + anchorRect.height / 2;
          left = anchorRect.right + marginPx;
          $tooltip.assignStyles({
            transform: "translateY(-50%)",
          });
          break;
        case "right-top":
          top = anchorRect.top;
          left = anchorRect.right + marginPx;
          $tooltip.assignStyles({
            transform: "none",
          });
          break;
        case "left":
          top = anchorRect.top + anchorRect.height / 2;
          left = anchorRect.left - marginPx;
          $tooltip.assignStyles({
            transform: "translateY(-50%) translateX(-100%)",
          });
          break;
        case "top":
          top = anchorRect.top - marginPx;
          left = anchorRect.left + anchorRect.width / 2;
          $tooltip.assignStyles({
            transform: "translateY(-100%) translateX(-50%)",
          });
          break;
        case "bottom":
          top = anchorRect.bottom + marginPx;
          left = anchorRect.left + anchorRect.width / 2;
          $tooltip.assignStyles({
            transform: "translateX(-50%)",
          });
          break;
        default:
          top = anchorRect.top;
          left = anchorRect.right + marginPx;
      }

      $tooltip.assignStyles({
        top: top + "px",
        left: left + "px",
      });
    };

    // Initial positioning and append to body
    updatePosition();
    $$.mutate(() => {
      document.body.appendChild($tooltip);
      // Trigger opacity animation after append
      setTimeout(() => {
        $tooltip.style.opacity = "1";
      }, 0);
    });

    // Set up scroll observer to track anchor movement
    currentScrollObserver = new ScrollAncestorObserver($anchor, updatePosition);
    currentScrollObserver.observe();

    $currentTooltip = $tooltip;

    const cleanup = () => {
      if (currentScrollObserver) {
        currentScrollObserver.unobserve();
        currentScrollObserver = undefined;
      }
      if ($tooltip.parentElement) {
        $tooltip.style.opacity = "0";
        setTimeout(() => {
          $tooltip.parentElement?.removeChild($tooltip);
        }, 150); // Match transition duration
      }
      if ($currentTooltip === $tooltip) {
        $currentTooltip = null;
      }
    };

    currentCleanup = cleanup;
    return cleanup;
  }

  export function hide(): void {
    currentCleanup?.();
    currentCleanup = null;
  }

  /**
   * Add tooltip behavior to an element on hover.
   * Returns a cleanup function to remove the listeners.
   */
  export function addHoverTooltip(
    $element: HTMLElement,
    text: string,
    position: Position = "right",
    marginPx: number = 8,
  ): () => void {
    let tooltipCleanup: Option<EmptyFunction>;
    let hoverTimeout: Option<number>;

    const showTooltip = () => {
      hoverTimeout = setTimeout(() => {
        tooltipCleanup = show(text, $element, position, marginPx);
      }, 500); // 500ms delay before showing
    };

    const hideTooltip = () => {
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      tooltipCleanup?.();
      tooltipCleanup = null;
    };

    $element.addEventListener("mouseenter", showTooltip);
    $element.addEventListener("mouseleave", hideTooltip);
    $element.addEventListener("blur", hideTooltip);

    return () => {
      hideTooltip();
      $element.removeEventListener("mouseenter", showTooltip);
      $element.removeEventListener("mouseleave", hideTooltip);
      $element.removeEventListener("blur", hideTooltip);
    };
  }
}
