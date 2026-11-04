import { NaiveDate } from "@tento-chrono";
import { EntryRow } from "../entry-list/entry-row";
import { EntryDisplay, ListItem } from "../entry-list/list-item";
import { CalendarMonth } from "./calendar-month";

export function createEventGhostSpan(
  item: ListItem,
  date: NaiveDate,
): CalendarMonth.Span {
  return {
    key: "event-list-ghost",
    contentSig: `event-list-ghost|${item.title}|${date.toString()}`,
    range: new NaiveDate.Range(date, date),
    isEditable: true,
    render: () => {
      return EntryRow.make()
        .bind(item, EntryDisplay.DEFAULT)
        .assignStyles({ "--entry-row-padding": "6px 6.5px" });
    },
  };
}
