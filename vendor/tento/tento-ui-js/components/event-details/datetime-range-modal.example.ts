import "./datetime-range-modal";

import {
  DateTimeRegion,
  naivedatetime,
  TimezoneRegion,
  Tzname,
} from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Toast } from "../toast/toast";
import { DateTimeRangeModal } from "./datetime-range-modal";
import { EventTime } from "./event-time";

export class DateTimeRangeModalStoryBook extends Storybook.Default {
  title(): string {
    return "DateTime Range Modal";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Timed Event",
        render: async () => {
          const start = naivedatetime(2025, 9, 6, 10, 0).withTzRegion(
            await TimezoneRegion.get("America/Los_Angeles" as Tzname),
          );
          const end = naivedatetime(2025, 9, 6, 14, 30).withTzRegion(
            await TimezoneRegion.get("America/Los_Angeles" as Tzname),
          );
          return DateTimeRangeModal.make().bind({
            title: "Edit Event Time",
            initialData: new EventTime(new DateTimeRegion.Range(start, end), false),
            onSave: (data: EventTime) => {
              if (data.isAllDay) {
                const dateRange = data.getDateRange()!;
                Toast.info("All-day event saved", {
                  description: `${dateRange.start} to ${dateRange.end}`,
                });
              } else {
                const duration = data.range.duration();
                Toast.info("Timed event saved", {
                  description: `Duration: ${duration.format({ showSeconds: false, padValues: false })}`,
                });
              }
            },
          });
        },
      },
      {
        title: "All-Day Event",
        render: async () => {
          const start = naivedatetime(2025, 9, 6).withTzRegion(
            await TimezoneRegion.get("America/Los_Angeles" as Tzname),
          );
          const end = naivedatetime(2025, 9, 8).withTzRegion(
            await TimezoneRegion.get("America/Los_Angeles" as Tzname),
          );
          return DateTimeRangeModal.make().bind({
            title: "Edit Event Time",
            initialData: new EventTime(new DateTimeRegion.Range(start, end), true),
            onSave: (data: EventTime) => {
              if (data.isAllDay) {
                const dateRange = data.getDateRange()!;
                Toast.info("All-day event saved", {
                  description: `${dateRange.start} to ${dateRange.end}`,
                });
              } else {
                const duration = data.range.duration();
                Toast.info("Timed event saved", {
                  description: `Duration: ${duration.format({ showSeconds: false, padValues: false })}`,
                });
              }
            },
          });
        },
      },
      {
        title: "Show modal (timed)",
        render: () => {
          const $button = Button.makeWithLight("Open timed event modal", {
            type: "primary",
            onClick: async () => {
              const start = naivedatetime(2025, 9, 6, 10, 0).withTzRegion(
                await TimezoneRegion.get("America/Los_Angeles" as Tzname),
              );
              const end = naivedatetime(2025, 9, 6, 14, 30).withTzRegion(
                await TimezoneRegion.get("America/Los_Angeles" as Tzname),
              );
              DateTimeRangeModal.show({
                title: "Edit Event Time",
                initialData: new EventTime(new DateTimeRegion.Range(start, end), false),
                onSave: (data: EventTime) => {
                  Toast.info(data.isAllDay ? "All-day" : "Timed", {
                    description: `isAllDay: ${data.isAllDay}`,
                  });
                },
              });
            },
          });
          return $button;
        },
      },
      {
        title: "Show modal (all-day)",
        render: () => {
          const $button = Button.makeWithLight("Open all-day event modal", {
            type: "secondary",
            onClick: async () => {
              const start = naivedatetime(2025, 9, 6).withTzRegion(
                await TimezoneRegion.get("America/Los_Angeles" as Tzname),
              );
              const end = naivedatetime(2025, 9, 9).withTzRegion(
                await TimezoneRegion.get("America/Los_Angeles" as Tzname),
              );
              DateTimeRangeModal.show({
                title: "Edit Event Time",
                initialData: new EventTime(new DateTimeRegion.Range(start, end), true),
                onSave: (data: EventTime) => {
                  Toast.info(data.isAllDay ? "All-day" : "Timed", {
                    description: `isAllDay: ${data.isAllDay}`,
                  });
                },
              });
            },
          });
          return $button;
        },
      },
    ];
  }
}
