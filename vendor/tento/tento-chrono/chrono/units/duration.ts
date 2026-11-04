import { DateUnit } from "./date-unit.ts";
import { DurationTime } from "./duration-time.ts";
import type { Optional } from "../option.ts";

// export class Duration {}

export namespace Duration {
  // biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
  export const Date = DateUnit;
  export type Date = DateUnit;

  export const Time = DurationTime;
  export type Time = DurationTime;

  export type Parts = DurationTime.Parts & DateUnit.Parts;
  export namespace Parts {
    export type Opt = Optional<Parts>;
  }
}
