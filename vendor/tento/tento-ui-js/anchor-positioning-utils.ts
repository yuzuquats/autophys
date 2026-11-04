import { ScrollAncestorObserver } from "./scroll-utils";
import { $$ } from "./fastdom";
import { Point } from "@tento-core/point";

/**
 * Unified offset configuration for inner (overlap) and outer (separated) positioning.
 *
 * - inner: offsets for overlap positions where content is placed on top of the anchor
 * - outer: offsets for separated positions where content is placed adjacent to the anchor
 */
export type OffsetConfig = {
  inner?: {
    vertical?: number;
    horizontal?: number;
  };
  outer?: {
    vertical?: number;
    horizontal?: number;
  };
};

/**
 * Legacy spacing configuration (deprecated).
 * Use OffsetConfig instead for better control over inner vs outer positioning.
 */
export type SpacingConfig = {
  vertical?: Option<number>;
  horizontal?: Option<number>;
};

/**
 * Layout specification returned by position functions.
 * Contains CSS positioning values (top, left, right, bottom, transform).
 */
export type LayoutSpec = {
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  transform?: string;
};

/**
 * Resolves offset configuration with defaults and legacy fallbacks.
 * Returns both inner and outer offsets with appropriate defaults.
 */
export function resolveOffsets(options: {
  offset?: Option<OffsetConfig>;
  spacing?: Option<SpacingConfig>;
}): {
  inner: { v: number; h: number };
  outer: { v: number; h: number };
} {
  const defaultOffset = 8;

  if (options.offset) {
    return {
      inner: {
        v: options.offset.inner?.vertical ?? defaultOffset,
        h: options.offset.inner?.horizontal ?? defaultOffset,
      },
      outer: {
        v: options.offset.outer?.vertical ?? defaultOffset,
        h: options.offset.outer?.horizontal ?? defaultOffset,
      },
    };
  }

  if (options.spacing) {
    const v = options.spacing.vertical ?? defaultOffset;
    const h = options.spacing.horizontal ?? defaultOffset;
    return {
      inner: { v, h },
      outer: { v, h },
    };
  }

  return {
    inner: { v: defaultOffset, h: defaultOffset },
    outer: { v: defaultOffset, h: defaultOffset },
  };
}

/**
 * Selects appropriate offset based on positioning mode.
 * Use inner offsets for overlap positions, outer offsets for separated positions.
 */
export function selectOffsetForMode(
  isOverlap: boolean,
  offsets: ReturnType<typeof resolveOffsets>,
): { v: number; h: number } {
  return isOverlap ? offsets.inner : offsets.outer;
}

/**
 * Detects if a position uses overlap (inner) mode.
 * Overlap positions place content inside/on top of the anchor.
 *
 * This function checks the position name for overlap-related keywords.
 */
export function isOverlapPosition(position: any): boolean {
  if (!position) return false;

  const overlapPatterns = [
    "OVERLAP",
    "TOP_LEFT_OVERLAP",
    "TOP_RIGHT_OVERLAP",
    "BOTTOM_LEFT_OVERLAP",
    "BOTTOM_RIGHT_OVERLAP",
    "RIGHT_OVERLAP",
  ];

  const positionName =
    typeof position === "function" ? position.name : String(position);
  return overlapPatterns.some((pattern) => positionName.includes(pattern));
}

/**
 * Converts a CSS coordinate value (with calc, %, px) to fixed viewport coordinates
 * based on anchor element position.
 *
 * This handles the conversion from relative positioning (%) to absolute positioning (px).
 */
export function convertLayoutSpecToFixed(
  spec: LayoutSpec,
  anchorRect: DOMRect,
): Record<string, string> {
  const styles: Record<string, string> = {};

  // Convert relative positioning to fixed coordinates
  if (spec.top) {
    if (spec.top.includes("calc")) {
      styles.top = spec.top.replace("100%", anchorRect.bottom + "px");
    } else if (spec.top.includes("%")) {
      styles.top = anchorRect.top + "px";
    } else {
      const offset = Number.parseFloat(spec.top);
      styles.top = anchorRect.top + offset + "px";
    }
  }
  if (spec.bottom) {
    if (spec.bottom.includes("calc")) {
      styles.bottom = spec.bottom.replace(
        "100%",
        window.innerHeight - anchorRect.top + "px",
      );
    } else {
      const offset = Number.parseFloat(spec.bottom);
      styles.bottom = window.innerHeight - anchorRect.bottom + offset + "px";
    }
  }
  if (spec.left) {
    if (spec.left.includes("calc")) {
      styles.left = spec.left.replace("100%", anchorRect.right + "px");
    } else if (spec.left.includes("%")) {
      styles.left = anchorRect.left + anchorRect.width / 2 + "px";
    } else {
      const offset = Number.parseFloat(spec.left);
      styles.left = anchorRect.left + offset + "px";
    }
  }
  if (spec.right) {
    if (spec.right.includes("calc")) {
      styles.right = spec.right.replace(
        "100%",
        window.innerWidth - anchorRect.left + "px",
      );
    } else {
      const offset = Number.parseFloat(spec.right);
      styles.right = window.innerWidth - anchorRect.right + offset + "px";
    }
  }
  if (spec.transform) {
    styles.transform = spec.transform;
  }

  return styles;
}

/**
 * Adjusts a position based on scroll delta between current and initial anchor position.
 * This is used to keep floating elements aligned with their anchor during scrolling.
 */
export function adjustPositionForScrollDelta(
  position: { x?: number; y?: number; top?: string; left?: string },
  currentAnchorRect: DOMRect,
  initialAnchorRect: DOMRect,
): typeof position {
  const scrollDeltaX = currentAnchorRect.left - initialAnchorRect.left;
  const scrollDeltaY = currentAnchorRect.top - initialAnchorRect.top;

  const adjusted = { ...position };

  if (adjusted.x != null) adjusted.x += scrollDeltaX;
  if (adjusted.y != null) adjusted.y += scrollDeltaY;
  if (adjusted.left) {
    const value = Number.parseFloat(adjusted.left);
    adjusted.left = value + scrollDeltaX + "px";
  }
  if (adjusted.top) {
    const value = Number.parseFloat(adjusted.top);
    adjusted.top = value + scrollDeltaY + "px";
  }

  return adjusted;
}

/**
 * Sets up a floating element with scroll tracking and position updates.
 *
 * This handles:
 * - Appending the element to the appropriate container
 * - Setting up scroll observers to track anchor movement
 * - Providing a cleanup function for removal
 */
export function setupFloatingElement(
  $element: HTMLElement,
  $anchor: HTMLElement,
  options: {
    container?: HTMLElement;
    updatePosition: () => void;
    escapeContainer?: boolean;
  },
): {
  scrollObserver: Option<ScrollAncestorObserver>;
  cleanup: () => void;
} {
  const container = options.container ?? document.body;
  const escapeContainer = options.escapeContainer ?? true;

  let scrollObserver: Option<ScrollAncestorObserver> = null;

  if (escapeContainer) {
    $$.mutate(() => {
      container.appendChild($element);
    });

    scrollObserver = new ScrollAncestorObserver(
      $anchor,
      options.updatePosition,
    );
    scrollObserver.observe();
  } else {
    $anchor.appendChild($element);
  }

  const cleanup = () => {
    scrollObserver?.unobserve();
    scrollObserver = null;
    $element.parentElement?.removeChild($element);
  };

  return { scrollObserver, cleanup };
}

/**
 * Parameters passed to position functions for layout calculation.
 */
export type LayoutParams = {
  marginBlockPx: number;
  marginInlinePx: number;
  parentRect: DOMRect;
  contentRect: DOMRect;
  scrollTop: number;
};

/**
 * A position function that takes layout parameters and returns CSS positioning values.
 */
export type Position = (params: LayoutParams) => LayoutSpec;

// --- Composable placement primitives (internal) ---

type PlacementType = "above" | "below" | "leftOf" | "rightOf" | "over";
type HorizontalAlign = "left" | "center" | "right";
type VerticalAlign = "top" | "center" | "bottom";

namespace Placement {
  export function above(params: LayoutParams): Partial<LayoutSpec> {
    return {
      bottom: `calc(100% + ${params.marginBlockPx}px)`,
    };
  }

  export function below(params: LayoutParams): Partial<LayoutSpec> {
    return {
      top: `calc(100% + ${params.marginBlockPx}px)`,
    };
  }

  export function leftOf(params: LayoutParams): Partial<LayoutSpec> {
    return {
      right: `calc(100% + ${params.marginInlinePx}px)`,
    };
  }

  export function rightOf(params: LayoutParams): Partial<LayoutSpec> {
    return {
      left: `calc(100% + ${params.marginInlinePx}px)`,
    };
  }

  export function over(_params: LayoutParams): Partial<LayoutSpec> {
    return {};
  }
}

namespace Align {
  export function horizontal(
    align: HorizontalAlign,
    params: LayoutParams,
  ): Partial<LayoutSpec> {
    switch (align) {
      case "left":
        return { left: `${params.marginInlinePx}px` };
      case "center":
        return {
          left: "50%",
          transform: "translateX(-50%)",
        };
      case "right":
        return { right: `${params.marginInlinePx}px` };
    }
  }

  export function vertical(
    align: VerticalAlign,
    params: LayoutParams,
  ): Partial<LayoutSpec> {
    switch (align) {
      case "top":
        return { top: `${params.marginBlockPx}px` };
      case "center":
        return {
          top: "50%",
          transform: "translateY(-50%)",
        };
      case "bottom":
        return { bottom: `${params.marginBlockPx}px` };
    }
  }
}

function mergeLayoutSpecs(...specs: Partial<LayoutSpec>[]): LayoutSpec {
  const merged: LayoutSpec = {};
  const transforms: string[] = [];

  for (const spec of specs) {
    for (const key in spec) {
      if (key === "transform") {
        transforms.push(spec[key as keyof LayoutSpec] as string);
      } else {
        const side = spec[key as keyof LayoutSpec];
        if (side !== undefined) merged[key as keyof LayoutSpec] = side;
      }
    }
  }

  if (transforms.length > 0) {
    merged.transform = transforms.join(" ");
  }

  return merged;
}

function compose(
  placement: PlacementType,
  horizontal: HorizontalAlign,
  vertical: VerticalAlign,
): Position {
  return (params: LayoutParams): LayoutSpec => {
    const placementFn = Placement[placement];
    const base = placementFn(params);

    let alignment: Partial<LayoutSpec>;
    if (
      placement === "above" ||
      placement === "below" ||
      placement === "over"
    ) {
      alignment = Align.horizontal(horizontal, params);
    } else {
      alignment = Align.vertical(vertical, params);
    }

    return mergeLayoutSpecs(base, alignment);
  };
}

function composeDiagonal(
  quadrant: "topLeft" | "topRight" | "bottomLeft" | "bottomRight",
): Position {
  return (params: LayoutParams): LayoutSpec => {
    const offset = 0;

    switch (quadrant) {
      case "topLeft":
        return {
          bottom: `calc(100% + ${params.marginBlockPx + offset}px)`,
          right: `calc(100% + ${params.marginInlinePx + offset}px)`,
        };
      case "topRight":
        return {
          bottom: `calc(100% + ${params.marginBlockPx + offset}px)`,
          left: `calc(100% + ${params.marginInlinePx + offset}px)`,
        };
      case "bottomLeft":
        return {
          top: `calc(100% + ${params.marginBlockPx + offset}px)`,
          right: `calc(100% + ${params.marginInlinePx + offset}px)`,
        };
      case "bottomRight":
        return {
          top: `calc(100% + ${params.marginBlockPx + offset}px)`,
          left: `calc(100% + ${params.marginInlinePx + offset}px)`,
        };
    }
  };
}

// --- Position namespace: pre-built position strategies ---

export namespace Position {
  // Edge positions (centered)
  export const TOP_CENTER = compose("above", "center", "top");
  export const BOTTOM_CENTER = compose("below", "center", "top");
  export const LEFT_CENTER = compose("leftOf", "left", "center");
  export const RIGHT_CENTER = compose("rightOf", "left", "center");

  // Top-Left quadrant
  export const TOP_LEFT_X: Position = (params: LayoutParams) => ({
    top: -params.marginBlockPx + "px",
    left: params.marginInlinePx + "px",
    transform: "translateY(-100%)",
  });

  export const TOP_LEFT_Y: Position = (params: LayoutParams) => ({
    top: params.marginBlockPx + "px",
    right: `calc(100% + ${params.marginInlinePx}px)`,
  });

  export const TOP_LEFT_OVERLAP: Position = (params: LayoutParams) => ({
    top: params.marginBlockPx + "px",
    left: params.marginInlinePx + "px",
  });

  export const TOP_LEFT = composeDiagonal("topLeft");

  // Legacy aliases (deprecated)
  export const TOP = TOP_LEFT_X;
  export const LEFT = TOP_LEFT_Y;
  export const OVERLAP = TOP_LEFT_OVERLAP;
  export const TOP_LEFT_DIAGONAL = TOP_LEFT;

  // Top-Right quadrant
  export const TOP_RIGHT_X = compose("above", "right", "top");

  export const TOP_RIGHT_Y: Position = (params: LayoutParams) => ({
    top:
      (params.parentRect.top + params.contentRect.height < 0
        ? params.scrollTop
        : params.marginBlockPx -
          Math.max(
            0,
            params.parentRect.top +
              params.contentRect.height -
              window.innerHeight,
          )) + "px",
    left: `calc(100% + ${params.marginInlinePx}px)`,
  });

  export const TOP_RIGHT_OVERLAP: Position = (params: LayoutParams) => ({
    top: params.marginBlockPx + "px",
    right: params.marginInlinePx + "px",
  });

  export const TOP_RIGHT = composeDiagonal("topRight");

  // Legacy aliases (deprecated)
  export const RIGHT = TOP_RIGHT_Y;
  export const RIGHT_OVERLAP = TOP_RIGHT_OVERLAP;
  export const TOP_RIGHT_DIAGONAL = TOP_RIGHT;

  // Bottom-Left quadrant
  export const BOTTOM_LEFT_X: Position = (params: LayoutParams) => ({
    bottom:
      -params.marginBlockPx -
      Math.max(
        0,
        params.parentRect.top + params.contentRect.height - window.innerHeight,
      ) +
      "px",
    left: params.marginInlinePx + "px",
    transform: "translateY(100%)",
  });

  export const BOTTOM_LEFT_OVERLAP: Position = (
    params: LayoutParams,
  ): LayoutSpec => ({
    bottom: params.marginBlockPx + "px",
    left: params.marginInlinePx + "px",
  });

  export const BOTTOM_LEFT_Y = compose("leftOf", "left", "bottom");

  export const BOTTOM_LEFT = composeDiagonal("bottomLeft");

  // Legacy aliases (deprecated)
  export const BOTTOM = BOTTOM_LEFT_X;
  export const LEFT_BOTTOM = BOTTOM_LEFT_Y;
  export const BOTTOM_LEFT_DIAGONAL = BOTTOM_LEFT;

  // Bottom-Right quadrant
  export const BOTTOM_RIGHT_OVERLAP: Position = (
    params: LayoutParams,
  ): LayoutSpec => ({
    bottom: params.marginBlockPx + "px",
    right: params.marginInlinePx + "px",
  });

  export const BOTTOM_RIGHT_X: Position = (
    params: LayoutParams,
  ): LayoutSpec => ({
    top: `calc(100% + ${params.marginBlockPx}px)`,
    right: params.marginInlinePx + "px",
  });

  export const BOTTOM_RIGHT_Y: Position = (
    params: LayoutParams,
  ): LayoutSpec => ({
    bottom: params.marginBlockPx + "px",
    left: `calc(100% + ${params.marginInlinePx}px)`,
  });

  export const BOTTOM_RIGHT = composeDiagonal("bottomRight");

  // Legacy aliases (deprecated)
  export const RIGHT_BOTTOM = BOTTOM_RIGHT_X;
  export const OVERLAP_BOTTOM_RIGHT = BOTTOM_RIGHT_Y;
  export const BOTTOM_RIGHT_DIAGONAL = BOTTOM_RIGHT;

  // Special positions
  export function fromPoint(p: Point): Position {
    return () => ({
      top: p.y + "px",
      left: p.x + "px",
    });
  }

  export namespace AtPoint {
    export function bottomRight(p: Point, size: Size): Position {
      return (params) => {
        return {
          top: p.y + params.parentRect.height + params.marginBlockPx + "px",
          left: p.x + params.parentRect.width - size.width + "px",
        };
      };
    }
  }
}
