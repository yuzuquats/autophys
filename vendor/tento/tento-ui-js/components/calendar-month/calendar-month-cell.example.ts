import { DateTime, NaiveDate, naivedate, TimezoneRegion } from "@tento-chrono";
import { Storybook } from "@tento-ui/ui/storybook";
import { CalendarMonthCell } from "./calendar-month-cell";
import { EntryDisplay } from "../entry-list/list-item";

export class CalendarMonthCellStoryBook extends Storybook.Default {
  title(): string {
    return "Calendar Month Cell";
  }

  examples(): Storybook.Example[] {
    const today = NaiveDate.today();
    const exampleTime = DateTime.utc.now();
    const timezone = TimezoneRegion.UTC;

    return [
      {
        title: "Calendar Month Cell",
        render: () => {
          return CalendarMonthCell.makeWithEvents({
            items: [
              {
                title: "Morning Standup",
                accentColor: "var(--teal)",
                at: exampleTime,
                timezone,
              },
              {
                title: "1:1 with Manager",
                accentColor: "var(--blue)",
                at: exampleTime,
                timezone,
              },
            ],
            display: EntryDisplay.DEFAULT,
          })
            .bindDate(today, today)
            .bindCurrentMonth(true)
            .assignStyles({
              width: "220px",
              height: "160px",
            });
        },
      },
      {
        title: "Current Month Date - Regular date in the current month",
        render: () => {
          const date = today.addDays(5);

          return CalendarMonthCell.make()
            .bindDate(date, today)
            .bindCurrentMonth(true)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
      {
        title:
          "Other Month Date - Date from previous/next month with dimmed appearance",
        render: () => {
          const date = naivedate(2024, 3, 15);

          return CalendarMonthCell.make()
            .bindDate(date, today)
            .bindCurrentMonth(false)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
      {
        title: "First Day of Month",
        render: () => {
          const firstDay = naivedate(2024, 1, 1);

          return CalendarMonthCell.make()
            .bindDate(firstDay, today)
            .bindCurrentMonth(true)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
      {
        title: "Last Day of Month (31st)",
        render: () => {
          // January has 31 days
          const date = naivedate(2024, 1, 31);

          return CalendarMonthCell.make()
            .bindDate(date, today)
            .bindCurrentMonth(true)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
      {
        title: "Weekend Date - Saturday",
        render: () => {
          // Saturday January 6, 2024
          const date = naivedate(2024, 1, 6);

          return CalendarMonthCell.make()
            .bindDate(date, today)
            .bindCurrentMonth(true)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
      {
        title: "Weekend Date - Sunday",
        render: () => {
          // Sunday January 7, 2024
          const date = naivedate(2024, 1, 7);

          return CalendarMonthCell.make()
            .bindDate(date, today)
            .bindCurrentMonth(true)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
      {
        title:
          "Previous Month's Trailing Days - Shows dates from the end of previous month",
        render: () => {
          // Last day of December 2023
          const date = naivedate(2023, 12, 31);

          return CalendarMonthCell.make()
            .bindDate(date, today)
            .bindCurrentMonth(false)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
      {
        title:
          "Next Month's Leading Days - Shows dates from the beginning of next month",
        render: () => {
          // First day of February 2024
          const date = naivedate(2024, 2, 1);

          return CalendarMonthCell.make()
            .bindDate(date, today)
            .bindCurrentMonth(false)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
      {
        title: "Leap Year Date - February 29th",
        render: () => {
          // 2024 is a leap year
          const date = naivedate(2024, 2, 29);

          return CalendarMonthCell.make()
            .bindDate(date, today)
            .bindCurrentMonth(true)
            .assignStyles({
              width: "100px",
              height: "80px",
            });
        },
      },
    ];
  }
}
