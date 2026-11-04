import { Day } from "./day.ts";
import type { Optional } from "../option.ts";

export type Unit<Id, Index, RelativeTo> = number & {
  readonly __id: Id;
  readonly __index: Index;
  readonly __relativeTo: RelativeTo;
};

export type DaysSinceEpoch = Day<0, "epoch">;
export type MsSinceEpoch = Unit<"ms", 0, "epoch">;
export namespace MsSinceEpoch {
  /**
   * `ms` read as milliseconds since the Unix epoch — the one place a plain
   * number (a JSON timestamp, `Date.now()`) takes the `MsSinceEpoch` unit.
   */
  export function of(ms: number): MsSinceEpoch {
    return ms as MsSinceEpoch;
  }
}
export type SecsSinceEpoch = Unit<"sec", 0, "epoch">;

/**
 * A span of time in milliseconds — the difference of two instants, not an
 * instant itself (an `MsSinceEpoch` is a point on the epoch axis).
 */
export type DurationMs = Unit<"ms", 0, "duration">;
export namespace DurationMs {
  /** The span from `start` to `end` (negative when `end` is earlier). */
  export function between(start: MsSinceEpoch, end: MsSinceEpoch): DurationMs {
    return (end - start) as DurationMs;
  }
}

export type MonthOfYear<Index> = number & { readonly __index: Index };
export type Month0 = MonthOfYear<0>;
export type Month1 = MonthOfYear<1>;

export type DayOfMonth<Index> = Day<Index, "month">;
export type DayOfMonth0 = Day<0, "month">;
export type DayOfMonth1 = Day<1, "month">;

export type DayOfWeek<Index, StartsOn> = Day<Index, "week"> & {
  readonly __startsOn: StartsOn;
};
export type DayOfWeek0<StartsOn = "sun"> = DayOfWeek<0, StartsOn>;
export type DayOfWeek1<StartsOn = "sun"> = DayOfWeek<1, StartsOn>;

export type DayOfYear<Index> = Day<Index, "year">;
export type DayOfYear0 = DayOfYear<0>;
export type DayOfYear1 = DayOfYear<1>;

export type WeekOfYear<Index> = Unit<"week", Index, "year">;
export type WeekOfYear0 = WeekOfYear<0>;
export type WeekOfYear1 = WeekOfYear<1>;

export type WeeksSinceEpoch<Index> = Unit<"week", Index, "epoch">;
export type WeeksSinceEpoch1 = WeeksSinceEpoch<1>;

export type Sign = 1 | -1;
export namespace Signed {
  export type Parts = {
    sign: Sign;
  };
  export namespace Parts {
    export type Opt = Optional<Parts>;
  }
}
