import { Time } from "../time.ts";
import { DaysSinceEpoch, MsSinceEpoch } from "./units.ts";
import { TentoMath } from "../utils.ts";

/**
 * Unix Epoch defined as
 *
 * January 1, 1970, 00:00:00 UTC
 */
export namespace Epoch {
  export function currentMse(): MsSinceEpoch {
    return Date.now() as MsSinceEpoch;
  }

  export function mseToDse(mse: MsSinceEpoch): DaysSinceEpoch {
    return TentoMath.floorDiv(mse, Time.MS_PER_DAY) as DaysSinceEpoch;
  }
}
