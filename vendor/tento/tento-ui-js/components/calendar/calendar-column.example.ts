import {
  DateFragment,
  DateTime,
  NaiveDate,
  TimeOfDay,
  TimezoneRegion,
  Utc,
} from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { CalendarColumn } from "./calendar-column";
import { CalendarColumnLayoutGroup } from "./calendar-column-layout-group";
import {
  createCalendarCell,
  type SimpleEvent,
} from "./calendar-column-cell.example";

export class CalendarColumnStoryBook extends Storybook.Default {
  title(): string {
    return "Calendar Column";
  }

  examples(): Storybook.Example[] {
    const today = NaiveDate.today();
    const startOfDay = today
      .withTime(TimeOfDay.fromHms({ hrs: 0 }))
      .withTz(Utc);
    const endOfDay = startOfDay.add({ hrs: 24 });

    // Create a DateFragment for the column binding
    const df = new DateFragment(
      new DateTime.Range(startOfDay, endOfDay),
      TimezoneRegion.UTC,
    );

    return [
      {
        title: "Calendar Column with Events",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Late Night Work",
              startHrs: 1,
              durationMins: 90,
              background: "var(--purple-dimmed)",
            },
            {
              id: "event-2",
              label: "Early Meeting",
              startHrs: 6,
              durationMins: 60,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-3",
              label: "Breakfast Call",
              startHrs: 6,
              startMins: 30,
              durationMins: 45,
              background: "var(--yellow-dimmed)",
            },
            {
              id: "event-4",
              label: "Morning Standup",
              startHrs: 9,
              durationMins: 30,
              background: "var(--teal-dimmed)",
            },
            {
              id: "event-5",
              label: "Team Sync",
              startHrs: 9,
              startMins: 15,
              durationMins: 30,
              background: "var(--purple-dimmed)",
            },
            {
              id: "event-6",
              label: "Lunch Break",
              startHrs: 12,
              durationMins: 60,
              background: "var(--orange-dimmed)",
            },
            {
              id: "event-7",
              label: "Client Call",
              startHrs: 14,
              durationMins: 45,
              background: "var(--green-dimmed)",
            },
            {
              id: "event-8",
              label: "Design Review",
              startHrs: 14,
              startMins: 30,
              durationMins: 60,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-9",
              label: "Code Review",
              startHrs: 16,
              durationMins: 30,
              background: "var(--red-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "576px",
            background: "var(--bg)",
          });
        },
      },
      {
        title: "Multiple Non-overlapping Events",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Early Workout",
              startHrs: 5,
              durationMins: 60,
              background: "var(--teal-dimmed)",
            },
            {
              id: "event-2",
              label: "Morning Standup",
              startHrs: 9,
              durationMins: 30,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-3",
              label: "Client Call",
              startHrs: 11,
              durationMins: 60,
              background: "var(--green-dimmed)",
            },
            {
              id: "event-4",
              label: "Lunch Break",
              startHrs: 13,
              durationMins: 60,
              background: "var(--orange-dimmed)",
            },
            {
              id: "event-5",
              label: "Code Review",
              startHrs: 15,
              durationMins: 45,
              background: "var(--purple-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "576px",
            background: "var(--bg)",
          });
        },
      },
      {
        title: "Layout: Simple 2-Column Overlap",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Event A",
              startHrs: 2,
              durationMins: 60,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-2",
              label: "Event B",
              startHrs: 2,
              startMins: 30,
              durationMins: 60,
              background: "var(--green-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "480px",
            background: "var(--bg)",
          });
        },
      },
      {
        title: "Layout: 3-Column Overlap",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Event A",
              startHrs: 3,
              durationMins: 90,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-2",
              label: "Event B",
              startHrs: 3,
              startMins: 15,
              durationMins: 75,
              background: "var(--green-dimmed)",
            },
            {
              id: "event-3",
              label: "Event C",
              startHrs: 3,
              startMins: 30,
              durationMins: 60,
              background: "var(--orange-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "480px",
            background: "var(--bg)",
          });
        },
      },
      {
        title: "Layout: 4+ Column Overlap",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Event A",
              startHrs: 4,
              durationMins: 120,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-2",
              label: "Event B",
              startHrs: 4,
              startMins: 10,
              durationMins: 90,
              background: "var(--green-dimmed)",
            },
            {
              id: "event-3",
              label: "Event C",
              startHrs: 4,
              startMins: 20,
              durationMins: 80,
              background: "var(--orange-dimmed)",
            },
            {
              id: "event-4",
              label: "Event D",
              startHrs: 4,
              startMins: 30,
              durationMins: 70,
              background: "var(--purple-dimmed)",
            },
            {
              id: "event-5",
              label: "Event E",
              startHrs: 4,
              startMins: 40,
              durationMins: 60,
              background: "var(--teal-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "480px",
            background: "var(--bg)",
          });
        },
      },
      {
        title: "Layout: Expand Capability (>15min gaps)",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Event A",
              startHrs: 5,
              durationMins: 60,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-2",
              label: "Event B (can expand)",
              startHrs: 5,
              startMins: 20,
              durationMins: 60,
              background: "var(--green-dimmed)",
            },
            {
              id: "event-3",
              label: "Event C (can expand)",
              startHrs: 5,
              startMins: 40,
              durationMins: 60,
              background: "var(--orange-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "480px",
            background: "var(--bg)",
          });
        },
      },
      {
        title: "Layout: No Expand (<15min gaps)",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Event A",
              startHrs: 6,
              durationMins: 60,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-2",
              label: "Event B (no expand)",
              startHrs: 6,
              startMins: 10,
              durationMins: 60,
              background: "var(--green-dimmed)",
            },
            {
              id: "event-3",
              label: "Event C (no expand)",
              startHrs: 6,
              startMins: 20,
              durationMins: 60,
              background: "var(--orange-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "480px",
            background: "var(--bg)",
          });
        },
      },
      {
        title: "Layout: Replacing First Column",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Event A",
              startHrs: 7,
              durationMins: 30,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-2",
              label: "Event B (overlaps A)",
              startHrs: 7,
              startMins: 15,
              durationMins: 30,
              background: "var(--green-dimmed)",
            },
            {
              id: "event-3",
              label: "Event C (replaces column 0)",
              startHrs: 7,
              startMins: 35,
              durationMins: 45,
              background: "var(--purple-dimmed)",
            },
            {
              id: "event-4",
              label: "Event D (overlaps C)",
              startHrs: 8,
              durationMins: 30,
              background: "var(--orange-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "480px",
            background: "var(--bg)",
          });
        },
      },
      {
        title: "Layout: Mixed Expand Behavior",
        render: () => {
          const $column = CalendarColumn.make();
          $column.bind(new DateFragment.Windowed(df));

          const $layout = CalendarColumnLayoutGroup.make();

          const events = [
            {
              id: "event-1",
              label: "Morning Block",
              startHrs: 1,
              durationMins: 120,
              background: "var(--blue-dimmed)",
            },
            {
              id: "event-2",
              label: "Quick Check (can expand)",
              startHrs: 1,
              startMins: 30,
              durationMins: 15,
              background: "var(--green-dimmed)",
            },
            {
              id: "event-3",
              label: "Follow-up (can expand)",
              startHrs: 2,
              durationMins: 30,
              background: "var(--orange-dimmed)",
            },
            {
              id: "event-4",
              label: "Late Join (no expand)",
              startHrs: 2,
              startMins: 10,
              durationMins: 40,
              background: "var(--purple-dimmed)",
            },
          ];

          for (const event of events) {
            $layout.appendChild(createCalendarCell(event, startOfDay));
          }

          $layout.layout();
          $column.appendChild($layout);

          return $column.assignStyles({
            width: "200px",
            height: "480px",
            background: "var(--bg)",
          });
        },
      },
    ];
  }
}
