import { Month0, Month1 } from "./units.ts";

export class Month {
  readonly mth1: Month1;

  constructor(mth1: Month1) {
    this.mth1 = mth1;
  }

  get mth(): Month1 {
    return this.mth1;
  }

  get mth0(): Month0 {
    return (this.mth1 - 1) as Month0;
  }

  get shortName(): string {
    return Month.MONTHS_OF_YEAR_SHORT[this.mth0];
  }

  get name(): string {
    return Month.MONTHS_OF_YEAR[this.mth0];
  }
}

export namespace Month {
  export const MONTHS_OF_YEAR = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  export const MONTHS_OF_YEAR_SHORT = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  export const JAN = new Month(1 as Month1);
  export const FEB = new Month(2 as Month1);
  export const MAR = new Month(3 as Month1);
  export const APR = new Month(4 as Month1);
  export const MAY = new Month(5 as Month1);
  export const JUN = new Month(6 as Month1);
  export const JUL = new Month(7 as Month1);
  export const AUG = new Month(8 as Month1);
  export const SEP = new Month(9 as Month1);
  export const OCT = new Month(10 as Month1);
  export const NOV = new Month(11 as Month1);
  export const DEC = new Month(12 as Month1);

  export const MONTHS0: Month[] = [
    JAN,
    FEB,
    MAR,
    APR,
    MAY,
    JUN,
    JUL,
    AUG,
    SEP,
    OCT,
    NOV,
    DEC,
  ];

  export const DAYS_IN_MONTH = [
    [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], // Non-leap year
    [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], // Leap year
  ];
  export const MONTH_START_OF_YEAR = [
    [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365], // Non-leap year
    [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366], // Leap year
  ];
}
