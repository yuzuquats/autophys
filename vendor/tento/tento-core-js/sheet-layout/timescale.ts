import { DateUnit, PartialDate } from "@tento-chrono";

export type TimeScale = DateUnit.Type;

export function getTimescaleOrder(timescale: TimeScale | "custom"): number {
  switch (timescale) {
    case "day":
      return 1;
    case "week":
      return 7;
    case "month":
      return 31;
    case "year":
      return 366;
    case "custom":
      return 1;
  }
}

export function getConservativeSpanCount(
  rowTimescale: TimeScale,
  sheetTimescale: TimeScale,
): number {
  if (rowTimescale === "week" && sheetTimescale === "day") return 7;
  if (rowTimescale === "month" && sheetTimescale === "day") return 31;
  if (rowTimescale === "year" && sheetTimescale === "day") return 366;
  if (rowTimescale === "month" && sheetTimescale === "week") return 5;
  if (rowTimescale === "year" && sheetTimescale === "week") return 53;
  if (rowTimescale === "year" && sheetTimescale === "month") return 12;
  return 1;
}

export function calculateStackSize(
  rowTimescale: TimeScale | "custom",
  sheetTimescale: TimeScale,
): Option<number> {
  const rowOrder = getTimescaleOrder(rowTimescale);
  const sheetOrder = getTimescaleOrder(sheetTimescale);
  if (rowOrder >= sheetOrder) return null;
  return Math.ceil(sheetOrder / rowOrder);
}

export function shouldStackCells(
  rowTimescale: TimeScale | "custom",
  sheetTimescale: TimeScale,
): boolean {
  return calculateStackSize(rowTimescale, sheetTimescale) !== null;
}

export function shouldSpanColumns(
  rowTimescale: TimeScale | "custom",
  sheetTimescale: TimeScale | "custom",
): boolean {
  if (rowTimescale === "custom" || sheetTimescale === "custom") return false;
  const rowOrder = getTimescaleOrder(rowTimescale);
  const sheetOrder = getTimescaleOrder(sheetTimescale);
  return rowOrder > sheetOrder;
}

export function isOwnerColumn(
  columnPd: PartialDate,
  rowPd: PartialDate,
): boolean {
  return (
    columnPd.start.dse < rowPd.end.dse && rowPd.end.dse <= columnPd.end.dse
  );
}

export function getOwnedRowPeriod(
  columnPd: PartialDate,
  rowTimescale: DateUnit.Type,
): Option<PartialDate> {
  const columnStart = columnPd.start;
  const startPeriod = PartialDate.fromDateAndType(rowTimescale, columnStart, columnPd.weekStart);
  if (isOwnerColumn(columnPd, startPeriod)) {
    return startPeriod;
  }
  return null;
}

export function getContainingPeriod(
  columnPd: PartialDate,
  rowTimescale: DateUnit.Type,
): PartialDate {
  const columnStart = columnPd.start;
  return PartialDate.fromDateAndType(rowTimescale, columnStart, columnPd.weekStart);
}
