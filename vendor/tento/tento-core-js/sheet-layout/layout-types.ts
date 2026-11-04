import type { DateUnit } from "@tento-chrono";

export type TimeScale = DateUnit.Type;

export interface LayoutSpec {
  cellHeight: number;
  maxStackHeight: Option<number>;
  maxStackedCells: Option<number>;
  seeMoreHeight: number;
  stackable: boolean;
  spannable: boolean;
  /**
   * Minimum timescale at which this row type can render meaningful content.
   * When the sheet timescale is finer than this (e.g., sheet="day", minWidth="week"),
   * the row enters span+stack mode: a fixed child spans minWidthTimescale columns
   * with subcells stacked at the sheet timescale inside.
   */
  minWidthTimescale: Option<TimeScale>;
}

