import { Unit } from "./units.ts";
import type { Optional } from "../option.ts";

export type Day<Index = any, RelativeTo = any> = Unit<"day", Index, RelativeTo>;
export namespace Day {
  export type To = {
    toDays: number;
  };

  export namespace To {
    export type Opt = Optional<To>;
  }

  export type ToF = {
    readonly toDaysF: number;
  };

  export type Parts = {
    readonly days: number;
  };

  export namespace Parts {
    export type Opt = Optional<Parts>;
  }
}
