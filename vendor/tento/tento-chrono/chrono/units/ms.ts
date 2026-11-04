import { Result, erm, ok } from "../result.ts";
import { Time } from "../time.ts";
import { Day } from "./day.ts";
import { Hms } from "./hour-mins-secs.ts";
import { Signed, Unit } from "./units.ts";
import type { Optional } from "../option.ts";

export type Ms = Unit<"ms", any, any>;
export namespace Ms {
  export type Parts = {
    readonly ms: number;
  };
  export namespace Parts {
    export type Opt = Optional<Parts>;
  }

  export type To = {
    readonly toMs: number;
  };
  export namespace To {
    export type Opt = Optional<To>;
  }

  export function resolve(
    parts: Optional<Hms.Parts & Ms.To & Ms.Parts & Day.Parts & Signed.Parts>,
  ): Ms {
    if (parts == null) {
      let i = 1;
      ++i;
    }
    const sign = parts.sign ?? 1;
    if (parts.toMs != null) return parts.toMs as Ms;
    let ms = 0;
    if (parts.ms != null) ms += parts.ms;
    if (parts.secs != null) ms += Time.MS_PER_SEC * parts.secs;
    if (parts.mins != null) ms += Time.MS_PER_MIN * parts.mins;
    if (parts.hrs != null) ms += Time.MS_PER_HR * parts.hrs;
    if (parts.days != null) ms += Time.MS_PER_DAY * parts.days;
    return (ms * sign) as Ms;
  }

  /**
   * Parses a string in format "HH:MM" or "HH:MM:SS" into milliseconds
   * Handles various edge cases and formats robustly
   */
  export function parse(s: string): Result<Ms> {
    // Trim whitespace
    const trimmed = s.trim();
    
    // Check for empty string
    if (!trimmed) {
      return erm(`Empty time string`);
    }

    // Split by colon
    const parts = trimmed.split(":");
    
    // Validate number of parts
    if (parts.length < 2 || parts.length > 3) {
      return erm(`Invalid time format: "${s}" - expected HH:MM or HH:MM:SS`);
    }

    // Check for extra content in any part (like "12:00 AM" where " AM" is extra)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      // Check if the part contains non-numeric characters
      if (!/^\d+$/.test(part)) {
        return erm(`Invalid time component: "${parts[i]}" contains non-numeric characters`);
      }
    }

    // Parse each component, handling leading zeros and padding
    const hrs = Number.parseInt(parts[0], 10);
    const mins = Number.parseInt(parts[1], 10);
    const secs = parts.length > 2 ? Number.parseInt(parts[2], 10) : 0;

    // Validate ranges
    if (hrs < 0) return erm(`Hours cannot be negative: ${hrs}`);
    if (hrs >= 24) return erm(`Hours must be less than 24: ${hrs}`);
    if (mins < 0) return erm(`Minutes cannot be negative: ${mins}`);
    if (mins >= 60) return erm(`Minutes must be less than 60: ${mins}`);
    if (secs < 0) return erm(`Seconds cannot be negative: ${secs}`);
    if (secs >= 60) return erm(`Seconds must be less than 60: ${secs}`);

    // Calculate total milliseconds
    const totalMs = hrs * Time.MS_PER_HR +
                   mins * Time.MS_PER_MIN +
                   secs * Time.MS_PER_SEC;

    return ok(totalMs as Ms);
  }
}
