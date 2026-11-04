import { Time } from "../time.ts";
import { TentoMath } from "../utils.ts";
import { Ms } from "./ms.ts";
import { TimeOfDay } from "./time-of-day.ts";
import { TimePoint } from "./time-point.ts";
import type { Option } from "../option.ts";

export type Meridiem = "am" | "pm";

export namespace Meridiem {
  /**
   * Gets the AM/PM meridiem indicator for the given hour
   */
  export function fromHours(hrs: number): "am" | "pm" {
    // Handle negative hours by wrapping
    const wrappedHour = ((hrs % 24) + 24) % 24;
    return wrappedHour >= 12 ? "pm" : "am";
  }
}

export class TimeWithMeridiem {
  readonly time: TimeOfDay;
  readonly mr: Option<Meridiem>;

  constructor(time: TimeOfDay, mr: Option<Meridiem>) {
    this.time = time;
    this.mr = mr;
  }

  resolve(defaultMr: Meridiem = "am"): Option<{
    time: TimeOfDay;
    displayHrs: number;
    merdiemPresent: boolean;
  }> {
    const mr = this.mr ?? defaultMr;

    let hrs = this.time.hrs;
    let timePoint: TimeOfDay;

    if (hrs === 12 && mr === "am") {
      hrs = 0;
      timePoint = TimeOfDay.wrap({
        ms: (this.time.toMs - 12 * Time.MS_PER_HR) as Ms,
      });
    } else if (hrs === 12 && mr === "pm") {
      hrs = 12;
      timePoint = TimeOfDay.wrap({
        ms: this.time.toMs as Ms,
      });
    } else if (mr === "pm") {
      hrs += 12;
      timePoint = TimeOfDay.wrap({
        ms: (this.time.toMs + 12 * Time.MS_PER_HR) as Ms,
      });
    } else {
      timePoint = TimeOfDay.wrap({
        ms: this.time.toMs as Ms,
      });
    }

    return {
      time: timePoint,
      displayHrs: hrs,
      merdiemPresent: this.mr != null,
    };
  }
}

export namespace TimeWithMeridiem {
  // Matches time with AM/PM: "5am", "5:30pm", "12:00 AM", etc.
  // Does NOT match plain numbers like "51" or "23"
  const MERIDIEM_REGEX =
    /^([0-1]?[0-9]|2[0-3])(?::([0-5][0-9]))?\s*(am|pm|AM|PM)$/;

  export function parse(text: string): Option<TimeWithMeridiem> {
    const trimmed = text.trim();
    const matches = trimmed.match(MERIDIEM_REGEX);
    if (!matches) return null;

    const [, hrs, mins, mrr] = matches;
    
    // AM/PM is required for this parser
    if (!mrr) return null;
    
    const timeOfDay = TimeOfDay.wrap({
      hrs: TentoMath.int(hrs),
      mins: TentoMath.int(mins) || 0,  // Default to 0 if minutes not provided
    });

    const mr: Meridiem = mrr.toLowerCase() as Meridiem;
    return new TimeWithMeridiem(timeOfDay, mr);
  }
}
