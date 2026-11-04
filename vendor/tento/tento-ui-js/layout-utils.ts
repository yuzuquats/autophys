/**
 * Layout Utilities
 *
 * Pure functions for positioning elements relative to anchors with viewport constraints.
 *
 * ## Coordinate System
 * - All coordinates are viewport-relative (fixed positioning)
 * - Origin (0,0) is top-left of viewport
 * - Positive X is right, positive Y is down
 *
 * ## Margin Conventions
 * - Margins define minimum spacing between content and boundaries
 * - Applied to both viewport edges and anchor element
 *
 * ## Strategy Composition
 * - Strategies are pure functions: LayoutContext → LayoutResult
 * - Compose with `tryInOrder()` to implement fallback behavior
 * - Use `auto()` for common "try all directions" pattern
 */

import { Inset as CoreInset } from "@tento-core/inset";
import type { Inset as CoreInsetType } from "@tento-core/inset";

// ============================================================================
// Core Types
// ============================================================================

/** Rectangle with position and dimensions */
export type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/** Point in 2D space */
export type Point = {
  x: number;
  y: number;
};

/** Width and height dimensions */
export type Size = {
  width: number;
  height: number;
};

/** Inset margins (spacing around content). */
export type Inset = CoreInsetType;
export const Inset = CoreInset;

/** Layout calculation parameters */
export type LayoutContext = {
  anchor: Rect;
  content: Size;
  viewport: Rect;
  margin: Inset;
  scrollOffset: Point;
};

/** Placement position relative to anchor */
export type Placement =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "left-top"
  | "left-bottom"
  | "right-top"
  | "right-bottom"
  | "center"
  | "overlay";

/** Layout calculation result */
export type LayoutResult = {
  x: number;
  y: number;
  placement: Placement;
  clipped: boolean;
};

/** Position calculator function */
export type PositionStrategy = (ctx: LayoutContext) => LayoutResult;

// ============================================================================
// Layout Utilities
// ============================================================================

export namespace LayoutUtils {
  /**
   * Calculate available space in all directions from anchor to viewport edges.
   * Space is measured from anchor edge to viewport edge, minus margin.
   */
  export function calculateSpace(ctx: LayoutContext): {
    top: number;
    bottom: number;
    left: number;
    right: number;
  } {
    return {
      top: ctx.anchor.top - ctx.viewport.top - ctx.margin.top,
      bottom: ctx.viewport.bottom - ctx.anchor.bottom - ctx.margin.bottom,
      left: ctx.anchor.left - ctx.viewport.left - ctx.margin.left,
      right: ctx.viewport.right - ctx.anchor.right - ctx.margin.right,
    };
  }

  /**
   * Check if content can fit in available space.
   */
  export function canFit(space: number, required: number): boolean {
    return space >= required;
  }

  /**
   * Clamp position to viewport bounds with margins.
   */
  export function clampToViewport(
    ctx: LayoutContext,
    x: number,
    y: number
  ): Point {
    const minX = ctx.viewport.left + ctx.margin.left;
    const maxX = ctx.viewport.right - ctx.content.width - ctx.margin.right;
    const minY = ctx.viewport.top + ctx.margin.top;
    const maxY = ctx.viewport.bottom - ctx.content.height - ctx.margin.bottom;

    return {
      x: Math.max(minX, Math.min(x, maxX)),
      y: Math.max(minY, Math.min(y, maxY)),
    };
  }
}

// ============================================================================
// Position Strategies
// ============================================================================

export namespace Strategies {
  /**
   * Position content below anchor, centered horizontally.
   * If content doesn't fit below, flip to above.
   */
  export function bottom(ctx: LayoutContext): LayoutResult {
    const space = LayoutUtils.calculateSpace(ctx);

    const x = ctx.anchor.left + (ctx.anchor.width - ctx.content.width) / 2;
    const y = ctx.anchor.bottom + ctx.margin.bottom;

    const clamped = LayoutUtils.clampToViewport(ctx, x, y);

    const fitsBelow = LayoutUtils.canFit(space.bottom, ctx.content.height);
    const finalY = fitsBelow
      ? clamped.y
      : ctx.anchor.top - ctx.content.height - ctx.margin.top;

    return {
      x: clamped.x,
      y: finalY,
      placement: fitsBelow ? "bottom" : "top",
      clipped: clamped.x !== x || finalY !== y,
    };
  }

  /**
   * Position content above anchor, centered horizontally.
   * If content doesn't fit above, flip to below.
   */
  export function top(ctx: LayoutContext): LayoutResult {
    const space = LayoutUtils.calculateSpace(ctx);

    const x = ctx.anchor.left + (ctx.anchor.width - ctx.content.width) / 2;
    const y = ctx.anchor.top - ctx.content.height - ctx.margin.top;

    const clamped = LayoutUtils.clampToViewport(ctx, x, y);

    const fitsAbove = LayoutUtils.canFit(space.top, ctx.content.height);
    const finalY = fitsAbove
      ? clamped.y
      : ctx.anchor.bottom + ctx.margin.bottom;

    return {
      x: clamped.x,
      y: finalY,
      placement: fitsAbove ? "top" : "bottom",
      clipped: clamped.x !== x || finalY !== y,
    };
  }

  /**
   * Position content to left of anchor, centered vertically.
   * If content doesn't fit left, flip to right.
   */
  export function left(ctx: LayoutContext): LayoutResult {
    const space = LayoutUtils.calculateSpace(ctx);

    const x = ctx.anchor.left - ctx.content.width - ctx.margin.left;
    const y = ctx.anchor.top + (ctx.anchor.height - ctx.content.height) / 2;

    const clamped = LayoutUtils.clampToViewport(ctx, x, y);

    const fitsLeft = LayoutUtils.canFit(space.left, ctx.content.width);
    const finalX = fitsLeft
      ? clamped.x
      : ctx.anchor.right + ctx.margin.right;

    return {
      x: finalX,
      y: clamped.y,
      placement: fitsLeft ? "left" : "right",
      clipped: finalX !== x || clamped.y !== y,
    };
  }

  /**
   * Position content to right of anchor, centered vertically.
   * If content doesn't fit right, flip to left.
   */
  export function right(ctx: LayoutContext): LayoutResult {
    const space = LayoutUtils.calculateSpace(ctx);

    const x = ctx.anchor.right + ctx.margin.right;
    const y = ctx.anchor.top + (ctx.anchor.height - ctx.content.height) / 2;

    const clamped = LayoutUtils.clampToViewport(ctx, x, y);

    const fitsRight = LayoutUtils.canFit(space.right, ctx.content.width);
    const finalX = fitsRight
      ? clamped.x
      : ctx.anchor.left - ctx.content.width - ctx.margin.left;

    return {
      x: finalX,
      y: clamped.y,
      placement: fitsRight ? "right" : "left",
      clipped: finalX !== x || clamped.y !== y,
    };
  }

  /**
   * Position content centered on anchor.
   */
  export function center(ctx: LayoutContext): LayoutResult {
    const x =
      ctx.anchor.left + (ctx.anchor.width - ctx.content.width) / 2;
    const y =
      ctx.anchor.top + (ctx.anchor.height - ctx.content.height) / 2;

    const clamped = LayoutUtils.clampToViewport(ctx, x, y);

    return {
      x: clamped.x,
      y: clamped.y,
      placement: "center",
      clipped: clamped.x !== x || clamped.y !== y,
    };
  }

  /**
   * Position content overlaying anchor (top-left aligned).
   */
  export function overlay(ctx: LayoutContext): LayoutResult {
    const x = ctx.anchor.left;
    const y = ctx.anchor.top;

    const clamped = LayoutUtils.clampToViewport(ctx, x, y);

    return {
      x: clamped.x,
      y: clamped.y,
      placement: "overlay",
      clipped: clamped.x !== x || clamped.y !== y,
    };
  }

  /**
   * Position content at a specific point.
   * Clamps to viewport bounds.
   */
  export function atPoint(point: Point): PositionStrategy {
    return (ctx: LayoutContext) => {
      const clamped = LayoutUtils.clampToViewport(ctx, point.x, point.y);

      return {
        x: clamped.x,
        y: clamped.y,
        placement: "center",
        clipped: clamped.x !== point.x || clamped.y !== point.y,
      };
    };
  }

  /**
   * Try multiple strategies in order, using first unclipped result.
   * Falls back to last strategy if all clip.
   */
  export function tryInOrder(
    strategies: PositionStrategy[]
  ): PositionStrategy {
    return (ctx: LayoutContext) => {
      for (const strategy of strategies) {
        const result = strategy(ctx);
        if (!result.clipped) return result;
      }
      return strategies[strategies.length - 1](ctx);
    };
  }

  /**
   * Auto-position: try bottom, top, right, left in order.
   * Uses first direction that fits without clipping.
   */
  export function auto(ctx: LayoutContext): LayoutResult {
    return tryInOrder([bottom, top, right, left])(ctx);
  }
}

// ============================================================================
// Conversion Utilities
// ============================================================================

export namespace Convert {
  /**
   * Convert DOMRect to Rect type.
   */
  export function fromDOMRect(rect: DOMRect): Rect {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  /**
   * Convert LayoutResult to CSS styles for fixed positioning.
   */
  export function toStyles(result: LayoutResult): {
    position: "fixed";
    left: string;
    top: string;
  } {
    return {
      position: "fixed",
      left: `${result.x}px`,
      top: `${result.y}px`,
    };
  }

  /**
   * Create uniform inset from single value.
   */
  export function inset(value: number): Inset {
    return Inset.all(value);
  }

  /**
   * Create viewport rect from window dimensions.
   */
  export function viewportRect(): Rect {
    return {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }
}
