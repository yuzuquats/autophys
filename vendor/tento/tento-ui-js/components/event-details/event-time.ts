import { DateTimeRegion, NaiveDate } from "@tento-chrono";

/**
 * Represents event timing with an all-day flag.
 * Underlying data is always a DateTimeRegion.Range.
 * When isAllDay is true, only the dates are meaningful (times ignored).
 */
export class EventTime {
  constructor(
    public readonly range: DateTimeRegion.Range,
    public readonly isAllDay: boolean,
  ) {}

  /**
   * Get the DateTimeRegion.Range if this is a timed event.
   * Returns null for all-day events.
   */
  getDateTimeRange(): Option<DateTimeRegion.Range> {
    return this.isAllDay ? null : this.range;
  }

  /**
   * Get the NaiveDate.Range if this is an all-day event.
   * Returns null for timed events.
   */
  getDateRange(): Option<NaiveDate.Range> {
    if (!this.isAllDay) return null;
    return new NaiveDate.Range(this.range.start.ndt.date, this.range.end.ndt.date);
  }
}
