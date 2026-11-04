import { Point } from "@tento-core/point";
import { PopoverInfo } from "./popover-info";

export { PopoverInfo };

/**
 * Calculates debug overlay information for scroll components.
 * Encapsulates all the math for positioning debug overlays and calculating space.
 */
export class ScrollLayoutSnapshot {
  readonly viewportInfo: ScrollLayoutSnapshot.ViewportInfo;

  constructor(
    readonly config: {
      viewportStartOffset: number;
      viewportSize: { width: number; height: number };
      scrollHeight: number;
      headerHeight: number;
      footerHeight: number;
      bodyHeight: number;
      scrollTop: number;
      location: "header" | "body" | "footer";
    },
  ) {
    if (config.location === "header") {
      this.viewportInfo = {
        x: config.viewportStartOffset,
        y: 0,
        width: config.viewportSize.width,
        height: config.viewportSize.height, // Full viewport height
        visibleHeight: config.viewportSize.height, // Same as height (no scrolling)
        scrollHeight: config.viewportSize.height, // No vertical scrolling
        scrollTop: config.scrollTop,
        padding: 0,
      };
    } else if (config.location === "footer") {
      // The footer is sticky-pinned to the viewport BOTTOM (its anchor spans
      // [viewportBottom − footerHeight, viewportBottom]) and footer-row offsets
      // are footer-section-relative (y = 0 at the footer's top). Express the
      // visible region in those footer-relative coords: the footer's bottom
      // coincides with the viewport bottom, and the rest of the viewport extends
      // UPWARD into negative y. So a popover taller than the short footer finds
      // its room above the anchor (spaceRemaining.top large, .bottom small) and
      // flips up into the body — exactly like a real bottom-anchored menu —
      // instead of being clamped into the body frame (the old shared else-branch
      // mispositioned every footer popover).
      this.viewportInfo = {
        x: config.viewportStartOffset,
        y: config.footerHeight - config.viewportSize.height,
        width: config.viewportSize.width,
        height: config.viewportSize.height,
        visibleHeight: config.viewportSize.height,
        scrollHeight: config.footerHeight,
        scrollTop: 0,
        padding: 0,
      };
    } else {
      this.viewportInfo = {
        x: config.viewportStartOffset,
        y: config.headerHeight,
        width: config.viewportSize.width,
        height: config.bodyHeight,
        visibleHeight: config.viewportSize.height - config.headerHeight, // Visible body height
        scrollHeight: config.scrollHeight,
        scrollTop: config.scrollTop,
        padding: 0,
      };
    }
  }

  resolvePosition(
    popoverInfo: PopoverInfo,
    constraintsChecker: ScrollLayoutSnapshot.ConstraintsChecker,
  ): {
    additional: Point;
    base: Point;
  } {
    // The bottom inset clamps a body popover above the sticky footer
    // (`#footers`, position:sticky bottom:0, height === footerHeight). Reserve
    // the REAL footer height — the same `sheet.layout.footerRowsHeightPx` that
    // `RowOptionsAnchor.onSpaceBottomChanged` shifts the row-options popover up
    // by — plus a small gap, instead of a fixed magic number that under-reserves
    // a taller (e.g. tasks-template, 128px) footer and lets the popover slide
    // under it. Header/footer-location popovers keep the prior inset (the
    // footer branch has its own footer-relative coordinate transform, so adding
    // footerHeight there would double-count).
    const FOOTER_GAP = 8;
    const bottomInset = this.config.location === "body"
      ? this.config.footerHeight + FOOTER_GAP
      : 64;
    const safeArea: Inset = { left: 4, right: 4, top: 0, bottom: bottomInset };

    const spaceRemaining = popoverInfo.spaceRemaining(
      this.viewportInfo,
    ).spaceRemaining;
    const { horizontal, vertical } = constraintsChecker(
      popoverInfo.canLayout(spaceRemaining),
    );

    return {
      additional: {
        x: popoverInfo.layoutHorizontal(spaceRemaining, safeArea, horizontal),
        y: 0,
      },
      base: {
        x: 0,
        y: popoverInfo.layoutVertical(spaceRemaining, safeArea, vertical),
      },
    };
  }
}

export namespace ScrollLayoutSnapshot {
  export interface ViewportInfo {
    x: number;
    y: number;
    width: number;
    height: number;
    visibleHeight: number;
    scrollHeight: number;
    scrollTop: number;
    padding: number;
  }

  export type ConstraintsChecker = (canLayout: {
    left: boolean;
    right: boolean;
    above: boolean;
    below: boolean;
  }) => {
    horizontal: PopoverInfo.HorizontalParams;
    vertical: PopoverInfo.VerticalParams;
  };
}
