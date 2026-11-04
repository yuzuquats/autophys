import type { Option } from "./option.ts";

export type GenericRangeLike<T> = { start: T; end: T };

export class GenericRange<T> implements GenericRangeLike<T> {
  public readonly start: T;
  public readonly end: T;

  constructor(start: T, end: T) {
    this.start = start;
    this.end = end;
  }
}

export function* range(s: number, e?: Option<number>): Generator<number> {
  const start = e == null ? 0 : s;
  const end = e == null ? s : e;
  for (let i = start; i < end; ++i) {
    yield i;
  }
}
