/**
 * Structured cell data for a secondary calendar row.
 *
 * A plain JSON object of primitives — a valid `Lisp.Atom` — so it
 * round-trips through `CellEntry.value: Option<CellData>` unchanged.
 */
export interface CalendarCellData {
  calYear: number;
  calMonth: number;
  calDay: number;
  /** Month name on day 1, localized day numeral otherwise. */
  label: string;
}

export function isCalendarCellData(v: unknown): v is CalendarCellData {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.calYear === "number" &&
    typeof o.calMonth === "number" &&
    typeof o.calDay === "number" &&
    typeof o.label === "string"
  );
}
