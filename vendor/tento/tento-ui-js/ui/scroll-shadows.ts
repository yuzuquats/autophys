import { Style, css } from "../component-styles";
import { $$ } from "../fastdom";

export namespace ScrollShadows {
  /**
   * Updates scroll shadow visibility based on scroll position
   * @param hostElement - The host element that will have shadow classes applied
   * @param scrollContainer - The element that is being scrolled
   */
  export function updateScrollShadows(
    hostElement: Element,
    scrollContainer: Element,
  ): void {
    $$.measure(() => {
      const scrollTop = scrollContainer.scrollTop;
      const scrollHeight = scrollContainer.scrollHeight;
      const clientHeight = scrollContainer.clientHeight;

      // Read tolerance from CSS variable (e.g., to account for dividers)
      // Add base tolerance of 2px for subpixel rendering issues
      const tolerance =
        (Number.parseFloat(
          getComputedStyle(hostElement).getPropertyValue(
            "--scroll-shadow-tolerance",
          ),
        ) || 0) + 2;

      // Check if content is scrollable
      const isScrollable = scrollHeight > clientHeight + tolerance;

      if (!isScrollable) {
        $$.mutate(() => {
          hostElement.classList.remove(
            "has-scroll-shadow-top",
            "has-scroll-shadow-bottom",
          );
        });
        return;
      }

      // Calculate shadow visibility based on scroll position
      const isAtTop = scrollTop <= 1; // Small threshold for rounding
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 1;

      const showTop = !isAtTop;
      const showBottom = !isAtBottom;

      // Update shadow classes
      $$.mutate(() => {
        hostElement.classList.toggle("has-scroll-shadow-top", showTop);
        hostElement.classList.toggle("has-scroll-shadow-bottom", showBottom);
      });
    });
  }

  /**
   * Updates horizontal scroll shadow visibility based on scroll position
   * @param hostElement - The host element that will have shadow classes applied
   * @param scrollContainer - The element that is being scrolled horizontally
   */
  export function updateHorizontalScrollShadows(
    hostElement: Element,
    scrollContainer: Element,
  ): void {
    $$.measure(() => {
      const scrollLeft = scrollContainer.scrollLeft;
      const scrollWidth = scrollContainer.scrollWidth;
      const clientWidth = scrollContainer.clientWidth;

      // Check if content is scrollable
      // Use 2px threshold to account for floating point rounding and sub-pixel rendering
      const isScrollable = scrollWidth > clientWidth + 2;

      if (!isScrollable) {
        $$.mutate(() => {
          hostElement.classList.remove(
            "has-scroll-shadow-left",
            "has-scroll-shadow-right",
          );
        });
        return;
      }

      // Calculate shadow visibility based on scroll position
      const isAtLeft = scrollLeft <= 1; // Small threshold for rounding
      const isAtRight = scrollLeft + clientWidth >= scrollWidth - 1;

      const showLeft = !isAtLeft;
      const showRight = !isAtRight;

      // Update shadow classes
      $$.mutate(() => {
        hostElement.classList.toggle("has-scroll-shadow-left", showLeft);
        hostElement.classList.toggle("has-scroll-shadow-right", showRight);
      });
    });
  }

  /**
   * Scroll shadow styles for vertical scrolling containers
   */
  export const $styles: Style.Compat = css`
    /* Vertical scroll shadow indicators */
    .scroll-shadow-top,
    .scroll-shadow-bottom {
      position: absolute;
      left: 16px;
      right: 16px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s ease;
      z-index: 2;
      box-shadow: 0 0 12px 3px light-dark(var(--black12), var(--black40));
    }

    .scroll-shadow-top {
      top: 0;
    }

    .scroll-shadow-bottom {
      bottom: 0;
    }

    /* Show shadows based on scroll state */
    :host(.has-scroll-shadow-top) .scroll-shadow-top {
      opacity: 1;
    }

    :host(.has-scroll-shadow-bottom) .scroll-shadow-bottom {
      opacity: 1;
    }
  `;

  /**
   * Scroll shadow styles for horizontal scrolling containers
   */
  export const $horizontalStyles: Style.Compat = css`
    /* Horizontal scroll shadow indicators */
    .scroll-shadow-left,
    .scroll-shadow-right {
      position: absolute;
      top: 0;
      bottom: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s ease;
      z-index: 2;
      width: 0px;
      box-shadow: 0 0 12px 3px light-dark(var(--black12), var(--black40));
    }

    .scroll-shadow-left {
      left: 0;
    }

    .scroll-shadow-right {
      right: 0;
    }

    /* Show shadows based on scroll state */
    :host(.has-scroll-shadow-left) .scroll-shadow-left {
      opacity: 1;
    }

    :host(.has-scroll-shadow-right) .scroll-shadow-right {
      opacity: 1;
    }
  `;
}
