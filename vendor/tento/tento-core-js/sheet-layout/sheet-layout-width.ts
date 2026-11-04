import { assert } from "@tento-core/assert";
import { MathUtils } from "@tento-core/math";
import { TaggedEnum } from "@tento-core/tagged-enum";

export namespace SheetLayoutWidth {
  export type Enum = {
    px: number;
    count: number;
  };
  export type Serialized = TaggedEnum<Enum>;
}

export class SheetLayoutWidth extends TaggedEnum.Base<SheetLayoutWidth.Enum> {
  static from(ser: SheetLayoutWidth.Serialized): SheetLayoutWidth {
    return new SheetLayoutWidth(ser);
  }

  static fromPx(width: number): SheetLayoutWidth {
    return new SheetLayoutWidth({
      type: "px",
      px: width,
    });
  }

  static fromCount(count: number): SheetLayoutWidth {
    assert(count > 0, "count must be > 0");
    return new SheetLayoutWidth({
      type: "count",
      count,
    });
  }

  static parseOpt(s: string): Option<SheetLayoutWidth> {
    const [n, type] = s.split(" ");
    const nn = MathUtils.parse(n);
    if (!nn) return null;
    switch (type) {
      case "count":
        return SheetLayoutWidth.fromCount(nn);
      case "px":
        return SheetLayoutWidth.fromPx(nn);
      default:
        return null;
    }
  }

  toString(): string {
    return this.match({
      px: (n) => `${n} px`,
      count: (n) => `${n} count`,
    });
  }

  dbg(): string {
    return this.toString();
  }
}

export namespace SheetLayoutWidth {
  export interface Constraints {
    weak: boolean;
    preferredWidthPx: number;
    minWidthPx: number;
  }

  export function resolveCellWidth(
    visibleWidth: number,
    semantic: SheetLayoutWidth,
    constraints: Constraints,
  ): Option<{
    semantic: SheetLayoutWidth;
    real: number;
  }> {
    const minCellWidth = constraints.weak
      ? constraints.preferredWidthPx
      : constraints.minWidthPx;
    const cellWidth = semantic.match({
      px: (n) => SheetLayoutWidth.fromPx(Math.max(n, minCellWidth)),
      count: (n) => {
        // NOTE: this occurs if the window is not yet rendered.
        if (minCellWidth === 0) return SheetLayoutWidth.fromCount(n);
        if (Number.isNaN(visibleWidth)) return SheetLayoutWidth.fromCount(n);
        if (n === 0) return SheetLayoutWidth.fromCount(1);

        const candidateNumColumns = Math.floor(visibleWidth / minCellWidth);
        return SheetLayoutWidth.fromCount(
          MathUtils.clampInc(candidateNumColumns, 1, n),
        );
      },
    });
    const naiveCellWidthPx = cellWidth.match({
      px: (n) => n,
      count: (n) => visibleWidth / n,
    });
    if (naiveCellWidthPx <= 0) return null;
    return {
      semantic: cellWidth,
      real: Math.max(20, naiveCellWidthPx),
    };
  }
}
