import type { Option, Optional } from "../option.ts";

export class DateUnit<Unit extends DateUnit.Type = any>
  implements DateUnit.Parts.Opt
{
  readonly value: number;
  readonly type: DateUnit.Type;

  get yrs(): Option<number> {
    return this.type === "year" ? this.value : null;
  }
  get mths(): Option<number> {
    return this.type === "month" ? this.value : null;
  }
  get days(): Option<number> {
    return this.type === "day" ? this.value : null;
  }
  get wks(): Option<number> {
    return this.type === "week" ? this.value : null;
  }

  constructor(value: number, type: DateUnit.Type) {
    this.value = value;
    this.type = type;
  }

  static years(yrs: number): DateUnit<"year"> {
    return new DateUnit(yrs, "year");
  }

  static months(mths: number): DateUnit<"month"> {
    return new DateUnit(mths, "month");
  }

  static days(days: number): DateUnit<"day"> {
    return new DateUnit(days, "day");
  }

  static weeks(wks: number): DateUnit<"week"> {
    return new DateUnit(wks, "week");
  }

  mult(scalar: number): DateUnit<Unit> {
    return new DateUnit(this.value * scalar, this.type);
  }

  equals(other: DateUnit): boolean {
    return this.value === other.value && this.type === other.type;
  }
}

export namespace DateUnit {
  export type Type = "year" | "month" | "day" | "week";

  export type Parts = {
    readonly yrs: number;
    readonly mths: number;
    readonly days: number;
    readonly wks: number;
  };

  export namespace Parts {
    export type Opt = Optional<Parts>;
  }
}
