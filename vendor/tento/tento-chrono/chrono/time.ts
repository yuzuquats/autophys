export namespace Time {
  export const HRS_PER_DAY = 24;
  export const DAYS_OF_WK = 7;

  export const MS_PER_SEC = 1_000;
  export const MS_PER_SEC_INV = 1 / 1_000;

  export const MS_PER_MIN = 60_000;
  export const MS_PER_MIN_INV = 1 / 60_000;

  export const MS_PER_HR = 3_600_000;
  export const MS_PER_HR_INV = 1 / 3_600_000;

  export const MS_PER_DAY = 86_400_000;
  export const MS_PER_DAY_INV = 1 / 86_400_000;

  export const MS_PER_WK = MS_PER_DAY * DAYS_OF_WK;
}
