import { Result } from "@tento-core/result";
import { TaggedEnum } from "@tento-core/tagged-enum";

export namespace CSSLength {
  export type Enum = {
    px: number;
    vw: number;
    percent: number;
  };
  export type Serialized = TaggedEnum<Enum>;
}

export class CSSLength extends TaggedEnum.Base<CSSLength.Enum> {
  static from(ser: CSSLength.Serialized): CSSLength {
    return new CSSLength(ser);
  }

  static fromString(s: string): Result<CSSLength, string> {
    const e = () => `'${s}' is not a number, can't parse to csslength`;
    if (s.endsWith("px")) {
      const n = Number.parseInt(s.slice(0, -2));
      if (Number.isNaN(n)) return Result.err(e());
      return Result.ok(CSSLength.fromPx(n));
    }
    if (s.endsWith("%")) {
      const n = Number.parseInt(s.slice(0, -1));
      if (Number.isNaN(n)) return Result.err(e());
      return Result.ok(CSSLength.fromPercent(n));
    }
    if (s.endsWith("vw")) {
      const n = Number.parseInt(s.slice(0, -2));
      if (Number.isNaN(n)) return Result.err(e());
      return Result.ok(CSSLength.fromVw(n));
    }
    return Result.err("unknown css length unit");
  }

  static fromPx(width: number): CSSLength {
    return new CSSLength({
      type: "px",
      px: width,
    });
  }

  static fromVw(width: number): CSSLength {
    return new CSSLength({
      type: "vw",
      vw: width,
    });
  }

  static fromPercent(width: number): CSSLength {
    return new CSSLength({
      type: "percent",
      percent: width,
    });
  }

  resolve(): string {
    return this.match({
      px: (n) => `${Math.round(n)}px`,
      vw: (n) => `${n}vw`,
      percent: (n) => `${n}%`,
    });
  }

  resolveToPx(referenceWidth?: Option<number>): number {
    return this.match({
      px: (n) => n,
      vw: (n) => (n / 100) * (referenceWidth ?? window.innerWidth),
      percent: (n) => (n / 100) * (referenceWidth ?? window.innerWidth),
    });
  }

  negate(): CSSLength {
    return this.match({
      px: (n) => CSSLength.fromPx(-n),
      vw: (n) => CSSLength.fromVw(-n),
      percent: (n) => CSSLength.fromPercent(-n),
    });
  }

  toString(): string {
    return this.resolve();
  }
}
