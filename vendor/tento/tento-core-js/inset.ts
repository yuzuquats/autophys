/** Edge insets in top/right/bottom/left order. */
export type Inset = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export namespace Inset {
  export const ZERO: Inset = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };

  export function all(value: number): Inset {
    return {
      top: value,
      right: value,
      bottom: value,
      left: value,
    };
  }

  export function top(value: number): Inset {
    return {
      top: value,
      right: 0,
      bottom: 0,
      left: 0,
    };
  }

  export function right(value: number): Inset {
    return {
      top: 0,
      right: value,
      bottom: 0,
      left: 0,
    };
  }

  export function bottom(value: number): Inset {
    return {
      top: 0,
      right: 0,
      bottom: value,
      left: 0,
    };
  }

  export function left(value: number): Inset {
    return {
      top: 0,
      right: 0,
      bottom: 0,
      left: value,
    };
  }

  export function add(a: Inset, b: Inset): Inset {
    return {
      top: a.top + b.top,
      right: a.right + b.right,
      bottom: a.bottom + b.bottom,
      left: a.left + b.left,
    };
  }

  export function max(a: Inset, b: Inset): Inset {
    return {
      top: Math.max(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
      left: Math.max(a.left, b.left),
    };
  }

  export function ceil(inset: Inset): Inset {
    return {
      top: Math.ceil(inset.top),
      right: Math.ceil(inset.right),
      bottom: Math.ceil(inset.bottom),
      left: Math.ceil(inset.left),
    };
  }

  export function horizontal(inset: Inset): number {
    return inset.left + inset.right;
  }

  export function vertical(inset: Inset): number {
    return inset.top + inset.bottom;
  }
}
