import { assert, nonnull } from "./assert";

export type RationalLike = {
  n: number;
  d: number;
};

/**
 * The Rational class represents a fraction with a numerator and denominator.
 * Used for precise representation of positions and other numerical values that require
 * exact fractional representation instead of floating point.
 */
export class Rational {
  constructor(
    public readonly n: number,
    public readonly d: number,
  ) {}

  toString(): string {
    return `${this.n}/${this.d}`;
  }

  inc(step: number = 1): Rational {
    return new Rational(this.n + step, this.d);
  }

  fraction(): number {
    if (this.d === 0) {
      console.error("tried to divide by 0");
      return 1;
    }
    return this.n / this.d;
  }
}

export namespace Rational {
  export function make(r: RationalLike): Rational {
    return new Rational(r.n, r.d);
  }

  export function makeOpt(r: Option<RationalLike>): Option<Rational> {
    if (!r) return null;
    return new Rational(r.n, r.d);
  }

  export function first(): Rational {
    return new Rational(1, 1);
  }

  /**
   * Returns a Rational representing the nth position.
   */
  export function nth(n: number): Rational {
    if (n > 0) {
      return new Rational(1, n + 1);
    } else if (n === 0) {
      return new Rational(1, 1);
    } else {
      return new Rational(1 - n + 1, 1);
    }
  }

  /**
   * Returns a Rational representing the next position after the current one.
   */
  export function prev(curr: Rational): Rational {
    return new Rational(curr.n + 1, curr.d);
  }

  export function next(curr: Rational): Rational {
    return new Rational(curr.n, curr.d + 1);
  }

  /**
   * Calculates the midpoint between two Rational positions.
   * - If only upper is provided: Returns a position just before upper
   * - If only lower is provided: Returns a position just after lower
   * - If both are provided: Returns the true midpoint (upper.n + lower.n)/(upper.d + lower.d)
   */
  export function midpoint(
    upper: Option<Rational>,
    lower: Option<Rational>,
  ): Rational {
    if (!upper) {
      lower = nonnull(lower);
      return new Rational(lower.n + 1, lower.d);
    }
    if (!lower) {
      upper = nonnull(upper);
      return new Rational(upper.n, upper.d + 1);
    }
    return new Rational(upper.n + lower.n, upper.d + lower.d);
  }

  /**
   * Converts a Rational to a string representation "n/d".
   */

  // biome-ignore lint/suspicious/noShadowRestrictedNames: toString
  export function toString(r: Rational): string {
    return `${r.n}/${r.d}`;
  }

  /**
   * Creates a Rational from a string representation "n/d".
   */
  export function fromString(s: string): Rational {
    const [n, d] = s.split("/");
    return new Rational(Number.parseInt(n), Number.parseInt(d));
  }

  /**
   * Compares two Rational values:
   * - Returns 1 if a < b
   * - Returns -1 if a > b
   * - Returns 0 if a === b
   *
   * Uses cross multiplication to compare without precision loss.
   */
  export function compare(a: Rational, b: Rational): number {
    assert(a.d < Number.MAX_SAFE_INTEGER);
    assert(a.n < Number.MAX_SAFE_INTEGER);
    assert(b.n < Number.MAX_SAFE_INTEGER);
    assert(b.d < Number.MAX_SAFE_INTEGER);
    const positionA = a.d * b.n;
    const positionB = b.d * a.n;
    if (positionA > positionB) return 1;
    else if (positionA < positionB) return -1;
    return 0;
  }
}
