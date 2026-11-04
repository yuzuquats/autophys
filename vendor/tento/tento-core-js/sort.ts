import { Rational } from "./rational";
import { assert, nonnull } from "./assert";

export interface UserOrderable {
  position: Rational;
}

export type UserOrderableOpt = Optional<UserOrderable>;

export namespace UserOrderable {
  export const compare = (a: UserOrderable, b: UserOrderable): number =>
    Rational.compare(a.position, b.position);

  export const compareOpt = (
    a: UserOrderableOpt,
    b: UserOrderableOpt,
  ): Option<number> => {
    if (a.position == null && b.position == null) return null;
    if (a.position == null) return 1;
    if (b.position == null) return -1;
    return Rational.compare(a.position, b.position);
  };

  export const compareOptChain = <T extends UserOrderableOpt>(
    orElse: (a: T, b: T) => number,
  ): ((a: T, b: T) => number) => {
    return (a: T, b: T): number => {
      const cmp = compareOpt(a, b);
      if (cmp == null) return orElse(a, b);
      return cmp;
    };
  };
}

export function getRationalMidpoint(
  upper: Option<Rational>,
  lower: Option<Rational>,
) {
  if (!upper) {
    lower = nonnull(lower);
    return { n: lower.n + 1, d: lower.d };
  }
  if (!lower) {
    upper = nonnull(upper);
    return { n: upper.n, d: upper.d + 1 };
  }
  return { n: upper.n + lower.n, d: upper.d + lower.d };
}
