import { DayOfMonth1, DaysSinceEpoch, Month1 } from "./units/units.ts";
import { Ymd1Like } from "./units/year-month-day.ts";

export namespace Gecko {
  const CYCLE_IN_YEARS = 400;
  const CYCLE_IN_DAYS = 146097;
  const CYCLE_IN_DAYS_INV = 1 / CYCLE_IN_DAYS;

  const RATA_DIE_1970_JAN1 = 719468;

  const s = 3670;
  const K = RATA_DIE_1970_JAN1 + s * CYCLE_IN_DAYS;
  const L = s * CYCLE_IN_YEARS;

  const U16_MAX = 65536;
  const U16_MAX_INV = 1 / U16_MAX;

  const U32_MAX = 4294967296;
  const U32_MAX_INV = 1 / U32_MAX;

  const C_2939745 = 2939745;
  const C_2939745_INV = 1 / C_2939745;

  const C_4_INV = 1 / 4;

  const C_2141 = 2141;
  const C_2141_INV = 1 / C_2141;

  //
  // js::ToYearMonthDay
  // https://github.com/mozilla/gecko-dev/blob/master/js/src/jsdate.cpp
  //
  // Adapted from Mozilla's temporal code.
  //
  // Fuzzy tested from Epoch(0...3000-1-1) against a Rust reference implementation
  //
  export function makeYmd(dse: DaysSinceEpoch): Ymd1Like {
    const N_U = dse;
    const N = N_U + K;

    const N_1 = 4 * N + 3;
    const C = Math.floor(N_1 * CYCLE_IN_DAYS_INV);
    const N_C = Math.floor((N_1 % CYCLE_IN_DAYS) * C_4_INV);

    // Year of the century Z and day of the year N_Y:
    const N_2 = 4 * N_C + 3;
    const P_2 = C_2939745 * N_2;
    const Z = Math.floor(P_2 * U32_MAX_INV);
    const N_Y = Math.floor(
      Math.floor((P_2 % U32_MAX) * C_2939745_INV) * C_4_INV,
    );

    const Y = 100 * C + Z;
    const N_3 = C_2141 * N_Y + 132377; // 132377 = 197913 - 65536
    const M = Math.floor(N_3 * U16_MAX_INV);
    const D = Math.floor((N_3 % U16_MAX) * C_2141_INV);

    const daysFromMar01ToJan01 = 306;
    const J = N_Y >= daysFromMar01ToJan01;
    const Y_G = Math.floor(Y - L + (J ? 1 : 0));
    const M_G = J ? M - 12 : M;
    const D_G = D;

    return {
      yr: Y_G,
      mth: (M_G + 1) as Month1,
      day: (D_G + 1) as DayOfMonth1,
    };
  }
}
