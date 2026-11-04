import { YearMonthDay } from "../units/year-month-day.ts";
import { ICalendar } from "./ical.ts";

/**
 * Utilities for Google Calendar-specific recurrence behavior
 */

/**
 * Detects the recurrence pattern for COUNT logic handling
 */
export enum CountPattern {
  STANDARD,           // Normal generator/filter behavior
  CONSECUTIVE_WEEKLY, // Monthly/weekly frequency with BYWEEKNO
  YEARLY_BYWEEKNO,    // Yearly frequency with BYWEEKNO
}

/**
 * Detects the COUNT pattern based on RRULE options
 */
export function detectCountPattern(
  inner: ICalendar.Raw,
  useGoogleCalendarBehavior?: boolean,
): CountPattern {
  const options = inner.rrule?.inner.options;
  const hasWeekNoFilter = options?.byweekno && options.byweekno.length > 0;
  
  if (!hasWeekNoFilter) {
    return CountPattern.STANDARD;
  }
  
  const freq = inner.rrule?.inner.freq;
  
  if (useGoogleCalendarBehavior && (freq === "monthly" || freq === "weekly")) {
    return CountPattern.CONSECUTIVE_WEEKLY;
  }
  
  if (freq === "yearly") {
    return CountPattern.YEARLY_BYWEEKNO;
  }
  
  return CountPattern.STANDARD;
}

/**
 * Calculates the generator start date for Google Calendar behavior
 */
export function calculateGoogleCalendarStartDate(
  originalStartDate: YearMonthDay,
  inner: ICalendar.Raw,
  useGoogleCalendarBehavior?: boolean,
): YearMonthDay {
  if (!useGoogleCalendarBehavior || !inner.rrule?.inner.options?.byweekno) {
    return originalStartDate;
  }

  const options = inner.rrule.inner.options;
  const hasWeekNoFilter = options.byweekno && options.byweekno.length > 0;
  
  // For yearly frequency with negative week numbers, we also need to adjust the start date
  // BUT only for consecutive weekly patterns, not for normal yearly patterns
  const shouldAdjustForNegativeWeekNo = hasWeekNoFilter && 
                                       inner.rrule.inner.freq === "yearly" && 
                                       options.byweekno!.some(w => w < 0) &&
                                       // Only adjust for consecutive weekly patterns, not yearly BYWEEKNO patterns
                                       false; // Disable this for now

  if (!shouldAdjustForNegativeWeekNo) {
    return originalStartDate;
  }

  // Calculate the starting date based on the first BYWEEKNO value
  // For consecutive weekly behavior, only use the first week number
  const weekno = options.byweekno![0];
  const targetYear = originalStartDate.yr;
  
  const calculatedStartDate = calculateWeekStartDate(
    targetYear,
    weekno,
    options.byday?.[0]?.dow
  );
  
  // Only adjust generator start date if it doesn't match the calculated target
  if (originalStartDate.dse !== calculatedStartDate.dse) {
    return calculatedStartDate;
  }

  return originalStartDate;
}

/**
 * Calculates the start date for a specific week number and optional day of week
 */
function calculateWeekStartDate(
  targetYear: number,
  weekno: number,
  targetDow?: number,
): YearMonthDay {
  let calculatedStartDate: YearMonthDay;
  
  if (weekno > 0) {
    // Positive week number - find the Monday of that week
    const jan4 = YearMonthDay.fromYmd1Exp(targetYear, 1, 4);
    let week1Monday = jan4;
    while (week1Monday.dayOfWeek.dow !== 2) {
      week1Monday = week1Monday.addDays(-1);
    }
    const targetMonday = week1Monday.addDays((weekno - 1) * 7);
    
    // If we have BYDAY filter, find the appropriate day of that week
    if (targetDow !== undefined) {
      // Monday is dow=2, so adjust accordingly
      const daysFromMonday = targetDow === 1 ? 6 : targetDow - 2;
      calculatedStartDate = targetMonday.addDays(daysFromMonday);
    } else {
      calculatedStartDate = targetMonday;
    }
  } else {
    // Negative week number - find the Monday of that week from the end
    let lastMondayOfYear = YearMonthDay.fromYmd1Exp(targetYear, 12, 31);
    while (lastMondayOfYear.dayOfWeek.dow !== 2) {
      lastMondayOfYear = lastMondayOfYear.addDays(-1);
    }
    const targetMonday = lastMondayOfYear.addDays((weekno + 1) * 7);
    
    // If we have BYDAY filter, find the appropriate day of that week
    if (targetDow !== undefined) {
      const daysFromMonday = targetDow === 1 ? 6 : targetDow - 2;
      calculatedStartDate = targetMonday.addDays(daysFromMonday);
    } else {
      calculatedStartDate = targetMonday;
    }
  }
  
  return calculatedStartDate;
}

/**
 * Determines if start date should be emitted separately for Google Calendar patterns
 */
export function shouldEmitStartDateSeparately(
  inner: ICalendar.Raw,
  startDate: YearMonthDay,
  pattern: CountPattern,
): boolean {
  // For yearly patterns with BYWEEKNO, don't emit start date separately - let the generator handle it
  // For negative week numbers, we need to be extra careful about start date emission
  return !!(inner && startDate && inner.rrule?.inner.options?.byday &&
    (inner.rrule.inner.freq !== "yearly" || pattern === CountPattern.STANDARD) &&
    // Don't emit start date separately for yearly BYWEEKNO patterns
    !(inner.rrule.inner.freq === "yearly" && pattern === CountPattern.YEARLY_BYWEEKNO));
}

/**
 * Checks if a start date matches the BYDAY filter
 */
export function startDateMatchesByday(
  startDate: YearMonthDay,
  bydayOptions: Array<{ dow: number }>,
): boolean {
  const startDateDow = startDate.dayOfWeek.dow;
  return bydayOptions.some((weekday) => weekday.dow === startDateDow);
}

/**
 * Creates a set of excluded dates from EXDATE rules
 */
export function createExcludedDatesSet(inner: ICalendar.Raw): Set<number> {
  return new Set(
    inner.lines.exdate?.flatMap(
      (exdate) => exdate.dates?.map((d) => d.dse) ?? [],
    ) ?? [],
  );
}

/**
 * Processes all events from a raw generator with COUNT logic and deduplication
 */
export function* processAllEvents(
  rawEvents: Generator<YearMonthDay>,
  pattern: CountPattern,
  countLimit?: number,
  startDate?: YearMonthDay,
  excl?: Set<number>,
  inner?: ICalendar.Raw,
): Generator<YearMonthDay> {
  let emittedCount = 0;
  const seenEvents = new Set<string>();
  
  // Use the stateless function to determine if start date should be emitted separately
  const shouldEmitStartSeparately = inner && startDate && shouldEmitStartDateSeparately(inner, startDate, pattern);
  
  // Handle start date emission for Google Calendar BYDAY patterns (non-yearly only)
  if (shouldEmitStartSeparately) {
    const options = inner!.rrule?.inner.options;
    if (options?.byday) {
      const matchesByday = startDateMatchesByday(startDate!, options.byday);

      if (matchesByday && !excl?.has(startDate!.dse)) {
        const startDateKey = startDate!.toString();
        if (!seenEvents.has(startDateKey)) {
          seenEvents.add(startDateKey);
          yield startDate!;
          emittedCount++;
          
          // Check COUNT limit after emitting start date
          if (countLimit && emittedCount >= countLimit) {
            return;
          }
        }
      }
    }
  }
  
  // Process all events from raw generator
  for (const event of rawEvents) {
    if (excl?.has(event.dse)) continue;
    
    // Deduplicate events
    const eventKey = event.toString();
    if (seenEvents.has(eventKey)) continue;
    seenEvents.add(eventKey);
    
    // Check COUNT limit before emitting
    if (countLimit && emittedCount >= countLimit) {
      return;
    }
    
    yield event;
    emittedCount++;
  }
}