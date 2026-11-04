import { MathUtils } from "@tento-core/math";
import { Point } from "@tento-core/point";
import { Rational } from "@tento-core/rational";

export class PopoverInfo {
  readonly position: Point;
  readonly anchorFrame: {
    left: number;
    width: number;
  };
  readonly edge: Inset;
  readonly size: Size;
  readonly subcolumn: Rational;
  readonly subcolumnWidth: number;
  readonly options: Option<
    Optional<{
      offsetY: number;
      margin: Inset;
      offset: {
        inner?: { vertical?: number; horizontal?: number | { left: number; right: number } };
        outer?: { vertical?: number; horizontal?: number | { left: number; right: number } };
      };
      anchorHeight: number;
    }>
  >;

  constructor(config: {
    position: Point;
    anchorFrame: {
      left: number;
      width: number;
    };
    edge: Inset;
    size: Size;
    subcolumn: Rational;
    subcolumnWidth: number;
    options?: Option<
      Optional<{
        offsetY: number;
        margin: Inset;
        offset: {
          inner?: { vertical?: number; horizontal?: number | { left: number; right: number } };
          outer?: { vertical?: number; horizontal?: number | { left: number; right: number } };
        };
        anchorHeight: number;
      }>
    >;
  }) {
    this.position = config.position;
    this.anchorFrame = config.anchorFrame;
    this.edge = config.edge;
    this.size = config.size;
    this.subcolumn = config.subcolumn;
    this.subcolumnWidth = config.subcolumnWidth;
    this.options = config.options;
  }

  get offsetY(): number {
    return this.options?.offsetY ?? 0;
  }

  private resolveOffsets(
    isOverlap: boolean,
  ): { vertical: number; horizontal: number | { left: number; right: number } } {
    const defaultOffset = 0;

    if (this.options?.offset) {
      if (isOverlap) {
        return {
          vertical: this.options.offset.inner?.vertical ?? defaultOffset,
          horizontal: this.options.offset.inner?.horizontal ?? defaultOffset,
        };
      }
      return {
        vertical: this.options.offset.outer?.vertical ?? defaultOffset,
        horizontal: this.options.offset.outer?.horizontal ?? defaultOffset,
      };
    }

    if (this.options?.margin) {
      return {
        vertical: (this.options.margin.top + this.options.margin.bottom) / 2,
        horizontal: (this.options.margin.left + this.options.margin.right) / 2,
      };
    }

    return {
      vertical: defaultOffset,
      horizontal: defaultOffset,
    };
  }

  spaceRemaining(
    frame: PopoverInfo.ContainerFrame,
  ): PopoverInfo.SpaceRemaining {
    // Calculate debug point position using top-left corner of the element
    // Don't include X offset - it should represent distance from arrow line
    // But DO include Y offset - it's needed for accurate space calculations
    const debugX =
      frame.x + this.edge.left + this.subcolumnWidth * this.subcolumn.n;
    // The debug overlay is positioned inside the scrolling container
    // The overlay's coordinate system starts at (0, headerHeight) in content coordinates
    const debugY = this.position.y + this.offsetY;

    // Calculate space remaining using the same logic as debug arrows
    const overlayWidth = frame.width;
    const padding = 0;

    // Convert debug point to relative coordinates within the overlay
    const overlayLeft = frame.x;
    const relativeX = debugX - overlayLeft;

    // Calculate horizontal distances to overlay edges
    const distanceToRight = Math.max(0, overlayWidth - relativeX - padding);
    const distanceToLeft = Math.max(0, relativeX - padding);

    // Calculate vertical distances relative to VISIBLE viewport, not content
    // Visible viewport in content coords: [scrollTop + frame.y, scrollTop + frame.y + visibleHeight]
    const visibleTop = frame.scrollTop + frame.y;
    const visibleBottom = frame.scrollTop + frame.y + frame.visibleHeight;
    const distanceToTop = Math.max(0, debugY - visibleTop - padding);
    const distanceToBottom = Math.max(0, visibleBottom - debugY - padding);

    // Actual space remaining = visual distance + padding (same as arrow labels)
    const spaceRemaining = {
      left: distanceToLeft + padding,
      right: distanceToRight + padding,
      top: distanceToTop + padding,
      bottom: distanceToBottom + padding,
    };

    return {
      x: debugX,
      y: debugY,
      spaceRemaining,
    };
  }

  canLayout(spaceRemaining: Inset): PopoverInfo.CanLayout {
    return {
      left: spaceRemaining.left > this.size.width,
      right: spaceRemaining.right > this.size.width,
      above: spaceRemaining.top > this.size.height,
      below: spaceRemaining.bottom > this.size.height,
    };
  }

  /**
   * Horizontal Popover Positioning
   *
   * The popover can be positioned relative to a subcolumn with optional overlap.
   * [lp] = left padding gap, [rp] = right padding gap
   *
   * ╔════════════════════════════════════════╗
   * ║                                        ║
   * ║      [ left/overlap ] [lp]             ║  position: "left",  overlap: true
   * ║ [ left ] [lp]                          ║  position: "left",  overlap: false
   * ║              [ subcolumn ]             ║
   * ║                           [rp] [right] ║  position: "right", overlap: false
   * ║              [rp] [right-overlap]      ║  position: "right", overlap: true
   * ║                                        ║
   * ╚════════════════════════════════════════╝
   *
   * - left (no overlap):  Popover RIGHT edge aligns to subcolumn LEFT edge, with gap
   * - left (overlap):     Popover RIGHT edge aligns to subcolumn RIGHT edge, with gap
   * - right (no overlap): Popover LEFT edge aligns to subcolumn RIGHT edge, with gap
   * - right (overlap):    Popover LEFT edge aligns to subcolumn LEFT edge, with gap
   * - center:             Popover centered horizontally over subcolumn
   */
  layoutHorizontal(
    spaceRemaining: Inset,
    safeArea: Inset,
    horizontal: PopoverInfo.HorizontalParams,
  ): number {
    const offsets = this.resolveOffsets(horizontal.overlap);
    // The horizontal offset may be a single scalar (symmetric) or per-side
    // { left, right } — used when one placement wants a gap and the other flush.
    const h = offsets.horizontal;
    const leftOffsetPx =
      this.options?.margin?.left ?? (typeof h === "number" ? h : h.left);
    const rightOffsetPx =
      this.options?.margin?.right ?? (typeof h === "number" ? h : h.right);

    // Calculate candidate position based on horizontal positioning
    let candidateX: number;
    switch (horizontal.position) {
      case "left":
        if (horizontal.overlap) {
          // Left with overlap: popover RIGHT edge at subcolumn RIGHT edge, with
          // gap. The gap pulls the box LEFT (away from the edge), so it is
          // SUBTRACTED — mirroring the right side, where the gap pushes +X.
          candidateX =
            this.subcolumnWidth * (this.subcolumn.n + 1) -
            this.size.width -
            leftOffsetPx;
        } else {
          // Left no overlap: popover RIGHT edge at subcolumn LEFT edge, with gap.
          // Gap pulls the box LEFT (away from the column), so SUBTRACT it; adding
          // it would push the right edge INTO the column and overlap the event.
          candidateX =
            this.subcolumnWidth * this.subcolumn.n -
            this.size.width -
            leftOffsetPx;
        }
        break;
      case "right":
        if (horizontal.overlap) {
          // Right with overlap: popover LEFT edge at subcolumn LEFT edge
          candidateX = this.subcolumnWidth * this.subcolumn.n + rightOffsetPx;
        } else {
          // Right no overlap: popover LEFT edge at subcolumn RIGHT edge
          candidateX =
            this.subcolumnWidth * (this.subcolumn.n + 1) + rightOffsetPx;
        }
        break;
      case "center":
        // Center popover on subcolumn:
        // subcolumn center = subcolumnWidth * (n + 0.5)
        // popover left = subcolumn center - popover width / 2
        candidateX =
          this.subcolumnWidth * (this.subcolumn.n + 0.5) - this.size.width / 2;
        break;
    }

    // Clamp to viewport bounds to prevent overflow
    //
    // spaceRemaining is calculated from the anchor point (subcolumn position),
    // but candidateX is relative to the column start. We need to account for
    // the subcolumn offset when calculating the clamping bounds.
    //
    // spaceRemaining.left = distance from anchor (column + subcolumnOffset) to viewport left
    // spaceRemaining.right = distance from anchor to viewport right
    //
    // For candidateX (column-relative):
    // - minX: tooltip left edge should not go past viewport left
    // - maxX: tooltip right edge should not go past viewport right
    const subcolumnOffset = this.subcolumnWidth * this.subcolumn.n;
    const minX = -spaceRemaining.left + subcolumnOffset + safeArea.left;
    const maxX =
      spaceRemaining.right + subcolumnOffset - this.size.width - safeArea.right;

    // Clamp candidateX to viewport bounds (same logic for all positions)
    let result = candidateX;

    if (candidateX < minX) {
      // Would overflow left - clamp to left edge
      result = minX;
    } else if (candidateX > maxX) {
      // Would overflow right - clamp to right edge
      result = maxX;
    }

    return result;
  }

  /**
   * Vertical Popover Positioning
   *
   * The popover can be positioned relative to an anchor with optional overlap.
   * [tp] = top padding gap, [bp] = bottom padding gap
   *
   * ╔════════════════════════════════════════╗
   * ║                                        ║
   * ║          [ above ]                     ║  position: "above", overlap: false
   * ║               [tp]                     ║
   * ║          [ above/overlap ]             ║  position: "above", overlap: true
   * ║              [ anchor ]                ║
   * ║          [ below/overlap ]             ║  position: "below", overlap: true
   * ║               [bp]                     ║
   * ║          [ below ]                     ║  position: "below", overlap: false
   * ║                                        ║
   * ╚════════════════════════════════════════╝
   *
   * - above (no overlap):  Popover BOTTOM edge aligns to anchor TOP edge
   * - above (overlap):     Popover BOTTOM edge aligns to anchor BOTTOM edge
   * - below (no overlap):  Popover TOP edge aligns to anchor BOTTOM edge
   * - below (overlap):     Popover TOP edge aligns to anchor TOP edge
   * - center:              Popover centered vertically over anchor
   */
  layoutVertical(
    spaceRemaining: Inset,
    safeArea: Inset,
    vertical: PopoverInfo.VerticalParams,
  ): number {
    // Calculate viewport bounds for the popover's top edge position
    // These bounds ensure the popover stays within the viewport with padding
    // Viewport top/bottom are derived from anchor position and space remaining
    const anchorY = this.position.y + this.offsetY;
    const viewportBounds = {
      // Minimum: top edge of popover at top edge of viewport (with padding)
      min: anchorY - spaceRemaining.top + safeArea.top,
      // Maximum: bottom edge of popover at bottom edge of viewport (with padding)
      max: anchorY + spaceRemaining.bottom - this.size.height - safeArea.bottom,
    };

    // Anchor dimensions (edge.top/bottom define the anchor's vertical extent)
    const anchorHeight = this.edge.bottom - this.edge.top;
    const anchorTop = this.position.y + this.offsetY;
    const anchorBottom = anchorTop + anchorHeight;

    // Resolve offsets based on overlap vs outer positioning
    const offsets = this.resolveOffsets(vertical.overlap);

    // Margin from options - spacing around the anchor
    const margin = this.options?.margin;
    let marginTop = margin?.top ?? offsets.vertical;
    const marginBottom = margin?.bottom ?? offsets.vertical;

    // Calculate candidate position based on vertical positioning
    let candidateY: number;
    switch (vertical.position) {
      case "above":
        if (vertical.overlap) {
          // Above with overlap: popover BOTTOM edge at anchor BOTTOM edge
          candidateY = anchorBottom - this.size.height;
        } else {
          // Above no overlap: popover BOTTOM edge at anchor TOP edge, with margin
          const optAnchorHeight = this.options?.anchorHeight ?? 0;
          candidateY =
            anchorTop - this.size.height - optAnchorHeight - marginTop;
        }
        break;
      case "below":
        if (vertical.overlap) {
          // Below with overlap: popover TOP edge at anchor TOP edge
          candidateY = anchorTop;
        } else {
          // Below no overlap: popover TOP edge at anchor BOTTOM edge, with margin
          candidateY = anchorBottom + marginBottom;
        }
        break;
      case "center":
        // Center popover on anchor
        candidateY = anchorTop + anchorHeight / 2 - this.size.height / 2;
        break;
    }

    // Clamp candidate to viewport bounds
    return MathUtils.clampInc(
      candidateY,
      viewportBounds.min,
      viewportBounds.max,
    );
  }
}

export namespace PopoverInfo {
  export type ContainerFrame = {
    x: number;
    y: number;
    width: number;
    height: number;
    scrollTop: number;
    visibleHeight: number;
  };

  export type SpaceRemaining = {
    x: number;
    y: number;
    spaceRemaining: Inset;
  };

  export type CanLayout = {
    left: boolean;
    right: boolean;
    above: boolean;
    below: boolean;
  };

  export type HorizontalParams = {
    position: "left" | "right" | "center";
    overlap: boolean;
  };

  export type VerticalParams = {
    position: "above" | "below" | "center";
    overlap: boolean;
  };
}
