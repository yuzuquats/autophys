import { NaiveDate } from "../naive-date.ts";
import { NaiveDateTime } from "../naive-datetime.ts";
import { NaiveTime } from "../naive-time.ts";
import { Result, err, ok } from "../result.ts";
import { Tzname } from "../timezone.ts";
import { IsoDate } from "./iso-date.ts";
import { TentoMath } from "../utils.ts";
import type { Option } from "../option.ts";

/**
 * Represents an EXDATE (exception date) property in iCalendar format.
 * Supports parsing of EXDATE lines with optional timezone and VALUE parameters.
 * 
 * Examples:
 * - EXDATE:20250902T220000Z
 * - EXDATE;TZID=America/Los_Angeles:20250902T220000
 * - EXDATE;VALUE=DATE:20250902,20250910
 * - EXDATE;TZID=Europe/London;VALUE=DATE-TIME:20250902T220000,20250910T143000
 */
export class ExDate {
  constructor(
    readonly dates: IsoDate[],
    readonly tzid: Option<Tzname> = null,
    readonly valueType: Option<"DATE" | "DATE-TIME"> = null,
  ) {}

  /**
   * Parse a single EXDATE line from an iCalendar recurrence array
   */
  static parse(exdateString: string): Result<ExDate> {
    if (!exdateString.startsWith("EXDATE")) {
      return err(Error("String must start with EXDATE"));
    }

    // Remove "EXDATE" prefix
    let remaining = exdateString.substring(6);

    // Parse parameters (everything before the colon)
    let tzid: Option<Tzname> = null;
    let valueType: Option<"DATE" | "DATE-TIME"> = null;
    
    // Check if there are parameters (starts with semicolon)
    if (remaining.startsWith(";")) {
      const colonIndex = remaining.indexOf(":");
      if (colonIndex === -1) {
        return err(Error("Invalid EXDATE format: missing colon after parameters"));
      }
      
      const paramString = remaining.substring(1, colonIndex);
      const dateString = remaining.substring(colonIndex + 1);
      
      // Parse parameters
      const params = ExDate.parseParameters(paramString);
      tzid = params.tzid;
      valueType = params.valueType;
      
      remaining = dateString;
    } else if (remaining.startsWith(":")) {
      // No parameters, just dates
      remaining = remaining.substring(1);
    } else {
      return err(Error("Invalid EXDATE format: expected ; or : after EXDATE"));
    }

    // Parse the dates (comma-separated)
    const dateStrings = remaining.split(",");
    const dates: IsoDate[] = [];
    
    for (const dateStr of dateStrings) {
      const trimmed = dateStr.trim();
      if (trimmed.length === 0) continue;
      
      // Parse based on value type
      let parseResult: Result<IsoDate>;
      
      if (valueType === "DATE") {
        // Date-only format (YYYYMMDD)
        parseResult = ExDate.parseDateOnly(trimmed);
      } else {
        // Try to parse as full datetime or date
        parseResult = IsoDate.parse(trimmed);
      }
      
      if (parseResult.isErr) {
        return err(Error(`Failed to parse date: ${trimmed} - ${parseResult.asErr()}`));
      }
      
      dates.push(parseResult.asOk()!);
    }

    if (dates.length === 0) {
      return err(Error("No valid dates found in EXDATE"));
    }

    return ok(new ExDate(dates, tzid, valueType));
  }

  /**
   * Parse multiple EXDATE lines from a recurrence array
   */
  static parseMultiple(recurrence: string[]): ExDate[] {
    const exdates: ExDate[] = [];
    
    for (const line of recurrence) {
      if (line.startsWith("EXDATE")) {
        const result = ExDate.parse(line);
        if (result.isOk) {
          exdates.push(result.asOk()!);
        }
      }
    }
    
    return exdates;
  }

  /**
   * Parse parameters from an EXDATE parameter string
   */
  private static parseParameters(paramString: string): {
    tzid: Option<Tzname>;
    valueType: Option<"DATE" | "DATE-TIME">;
  } {
    let tzid: Option<Tzname> = null;
    let valueType: Option<"DATE" | "DATE-TIME"> = null;
    
    const params = paramString.split(";");
    for (const param of params) {
      const [key, value] = param.split("=");
      if (!key || !value) continue;
      
      const upperKey = key.toUpperCase();
      
      if (upperKey === "TZID") {
        tzid = value as Tzname;
      } else if (upperKey === "VALUE") {
        const upperValue = value.toUpperCase();
        if (upperValue === "DATE" || upperValue === "DATE-TIME") {
          valueType = upperValue as "DATE" | "DATE-TIME";
        }
      }
    }
    
    return { tzid, valueType };
  }

  /**
   * Parse a date-only string (YYYYMMDD format)
   */
  private static parseDateOnly(dateStr: string): Result<IsoDate> {
    const regex = /^(\d{4})(\d{2})(\d{2})$/;
    const match = dateStr.match(regex);
    
    if (!match) {
      return err(Error(`Invalid date format: ${dateStr}`));
    }
    
    const [_, year, month, day] = match;
    const ndr = NaiveDate.fromYmd1Str(year, month, day);
    
    if (ndr.isErr) {
      return ndr.expeCast();
    }
    
    return ok(new IsoDate(ndr.asOk()!, null, null));
  }

  /**
   * Convert back to iCalendar EXDATE format
   */
  toString(): string {
    const parts: string[] = ["EXDATE"];
    
    // Add parameters
    const params: string[] = [];
    if (this.tzid) {
      params.push(`TZID=${this.tzid}`);
    }
    if (this.valueType) {
      params.push(`VALUE=${this.valueType}`);
    }
    
    if (params.length > 0) {
      parts.push(`;${params.join(";")}`);
    }
    
    // Add dates
    const dateStrings = this.dates.map(d => d.ical());
    parts.push(`:${dateStrings.join(",")}`);
    
    return parts.join("");
  }

  /**
   * Get all exception dates as NaiveDate objects
   */
  getNaiveDates(): NaiveDate[] {
    return this.dates.map(d => d.trunc());
  }

  /**
   * Check if a given date is an exception date
   */
  isExceptionDate(date: NaiveDate): boolean {
    return this.dates.some(d => d.trunc().equals(date));
  }

  /**
   * Merge multiple ExDate objects into one
   */
  static merge(exdates: ExDate[]): ExDate {
    if (exdates.length === 0) {
      return new ExDate([]);
    }
    
    // Use the timezone and value type from the first ExDate
    const first = exdates[0];
    const allDates: IsoDate[] = [];
    
    for (const exdate of exdates) {
      allDates.push(...exdate.dates);
    }
    
    // Remove duplicates based on string representation
    const uniqueDates = new Map<string, IsoDate>();
    for (const date of allDates) {
      const key = date.toString();
      if (!uniqueDates.has(key)) {
        uniqueDates.set(key, date);
      }
    }
    
    return new ExDate(
      Array.from(uniqueDates.values()),
      first.tzid,
      first.valueType
    );
  }
}