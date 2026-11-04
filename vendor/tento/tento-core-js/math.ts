export namespace MathUtils {
  export const lerp = (min: number, max: number, progress: number): number => {
    return min + (max - min) * progress;
  };

  export const easeInSine = (x: number): number => {
    return 1 - Math.cos((x * Math.PI) / 2);
  };

  export const easeInElastic = (x: number): number => {
    const c4 = (2 * Math.PI) / 3;
    return x === 0
      ? 0
      : x === 1
        ? 1
        : -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4);
  };

  export const easeOutCubic = (x: number): number => {
    return clampInc(1 - Math.pow(1 - x, 3), 0, 1);
  };

  export function clampInc(num: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, num));
  }

  export function numberOrNull(n: Option<number>): Option<number> {
    if (n == null || n === undefined) return null;
    if (Number.isNaN(n)) return null;
    return n;
  }

  export function mod(n: number, mod: number): number {
    if (n > 0) return n % mod;
    return (mod - (-n % mod)) % mod;
  }

  /**
   * The quotient rounded toward negative infinity: `floorDiv(-1, 4) === -1`,
   * `floorDiv(-5, 4) === -2`. Exact for safe integers: the remainder is taken
   * off before dividing, so the division never rounds.
   */
  export function floorDiv(dividend: number, divisor: number): number {
    const remainder = dividend % divisor;
    const quotient = (dividend - remainder) / divisor;
    return remainder !== 0 && (remainder < 0) !== (divisor < 0) ? quotient - 1 : quotient;
  }

  export function clampR(
    value: number,
    range: {
      start: number;
      end: number;
    },
  ): number {
    if (value < range.start) return range.start;
    if (value > range.end) return range.end;
    return value;
  }

  export function roundToDecimals(num: number, decimals: number = 2): number {
    const factor = Math.pow(10, decimals);
    return Math.round(num * factor) / factor;
  }

  export function parse(
    s: Option<string>,
    fn: (s: string) => number = Number.parseFloat,
  ): Option<number> {
    if (!s) return null;
    const n = fn(s);
    if (Number.isNaN(n)) return null;
    return n;
  }
}
