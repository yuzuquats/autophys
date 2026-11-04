import {
  DateTime,
  NaiveDate,
  TimeOfDay,
  TimePoint,
  TimezoneRegion,
  Utc,
} from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { CalendarColumnCell } from "./calendar-column-cell";

export type SimpleEvent = {
  id: string;
  label: string;
  startHrs: number;
  startMins?: number;
  durationMins: number;
  background: string;
};

export function createCalendarCell(
  event: SimpleEvent,
  baseDate: DateTime<"utc">,
): CalendarColumnCell.Basic {
  const $cell = CalendarColumnCell.basic();

  const startTimeOfDay = TimeOfDay.fromHms({
    hrs: event.startHrs,
    mins: event.startMins ?? 0,
  });
  const startTimePoint = new TimePoint(0, startTimeOfDay);
  const endTimePoint = startTimePoint.add({ mins: event.durationMins });

  const startDateTime = baseDate.withTime(startTimeOfDay);
  const endDateTime = startDateTime.add({ mins: event.durationMins });

  $cell.bind({
    id: event.id,
    time: new TimePoint.Range(startTimePoint, endTimePoint),
  });
  $cell.$content().bind({
    label: event.label,
    time: new TimePoint.Range(startTimePoint, endTimePoint),
    timeLabel: new DateTime.Range(startDateTime, endDateTime),
  });
  $cell.assignStyles({
    "--std-calendar-cell-background": event.background,
  });

  return $cell;
}

export class CalendarColumnCellStoryBook extends Storybook.Default {
  title(): string {
    return "Calendar Column Cell";
  }

  examples(): Storybook.Example[] {
    const today = NaiveDate.today();
    const startOfDay = today
      .withTime(TimeOfDay.fromHms({ hrs: 0 }))
      .withTz(Utc);

    return [
      ...[false, true].map((loading): Storybook.Example => ({
        title: `Narrow content (${loading ? "loading" : "loaded"})`,
        render: () => {
          const $cell = createCalendarCell(
            {
              id: "narrow-content",
              label: "Long calendar event title with multiple words",
              startHrs: 9,
              durationMins: 120,
              background: "var(--blue-dimmed)",
            },
            startOfDay,
          );
          $cell.toggleLoading(loading);
          return $cell.assignStyles({
            position: "relative",
            width: "80px",
            transform: "none",
          });
        },
      })),
      {
        title: "Basic Cell (30 mins)",
        render: () => {
          const $cell = createCalendarCell(
            {
              id: "basic",
              label: "Morning Meeting",
              startHrs: 9,
              durationMins: 30,
              background: "var(--blue-dimmed)",
            },
            startOfDay,
          );

          return $cell.assignStyles({
            position: "relative",
            width: "200px",
            transform: "none",
          });
        },
      },
      {
        title: "Short Cell (15 mins)",
        render: () => {
          const $cell = createCalendarCell(
            {
              id: "short",
              label: "Quick Check",
              startHrs: 10,
              durationMins: 15,
              background: "var(--green-dimmed)",
            },
            startOfDay,
          );

          return $cell.assignStyles({
            position: "relative",
            width: "200px",
            transform: "none",
          });
        },
      },
      {
        title: "Long Cell (2 hours)",
        render: () => {
          const $cell = createCalendarCell(
            {
              id: "long",
              label: "Deep Work Session",
              startHrs: 14,
              durationMins: 120,
              background: "var(--purple-dimmed)",
            },
            startOfDay,
          );

          return $cell.assignStyles({
            position: "relative",
            width: "200px",
            transform: "none",
          });
        },
      },
      {
        title: "Loading State (60 mins)",
        render: () => {
          const $cell = createCalendarCell(
            {
              id: "loading-60",
              label: "Syncing Event",
              startHrs: 11,
              durationMins: 60,
              background: "var(--blue-dimmed)",
            },
            startOfDay,
          );

          $cell.toggleLoading(true);

          return $cell.assignStyles({
            position: "relative",
            width: "200px",
            transform: "none",
            border: "1px solid var(--divider)",
          });
        },
      },
      {
        title: "Loading State (30 mins)",
        render: () => {
          const $cell = createCalendarCell(
            {
              id: "loading-30",
              label: "Quick Sync",
              startHrs: 10,
              durationMins: 30,
              background: "var(--green-dimmed)",
            },
            startOfDay,
          );

          $cell.toggleLoading(true);

          return $cell.assignStyles({
            position: "relative",
            width: "200px",
            transform: "none",
            border: "1px solid var(--divider)",
          });
        },
      },
      {
        title: "Loading State (15 mins)",
        render: () => {
          const $cell = createCalendarCell(
            {
              id: "loading-15",
              label: "Brief Update",
              startHrs: 9,
              durationMins: 15,
              background: "var(--orange-dimmed)",
            },
            startOfDay,
          );

          $cell.toggleLoading(true);

          return $cell.assignStyles({
            position: "relative",
            width: "200px",
            transform: "none",
            border: "1px solid var(--divider)",
          });
        },
      },
    ];
  }
}
