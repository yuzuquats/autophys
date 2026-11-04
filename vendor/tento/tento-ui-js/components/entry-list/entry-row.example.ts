import { Storybook } from "@tento-ui/ui/storybook";
import { EntryRow } from "./entry-row";
import { EntryDisplay } from "./list-item";
import { DateTime, TimezoneRegion } from "@tento-chrono";

export class EntryRowStoryBook extends Storybook.Default {
  title(): string {
    return "Entry Row";
  }

  examples(): Storybook.Example[] {
    const exampleTime = DateTime.utc.now();
    const timezone = TimezoneRegion.UTC;

    return [
      {
        title: "Basic Entry Row",
        render: () => {
          return EntryRow.make()
            .bind(
              {
                title: "Team Standup",
                accentColor: "var(--red)",
                at: exampleTime,
                timezone,
              },
              { ...EntryDisplay.DEFAULT, timeScale: "day" },
            )
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              padding: "8px",
            });
        },
      },
      {
        title: "Entry Row (Time = week)",
        render: () => {
          return EntryRow.make()
            .bind(
              {
                title: "Product Review Meeting",
                accentColor: null,
                at: exampleTime,
                timezone,
              },
              { ...EntryDisplay.DEFAULT, timeScale: "week" },
            )
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              padding: "8px",
            });
        },
      },
      {
        title: "Entry Row (Time = Month)",
        render: () => {
          return EntryRow.make()
            .bind(
              {
                title: "Product Review Meeting",
                accentColor: null,
                at: exampleTime,
                timezone,
              },
              { ...EntryDisplay.DEFAULT, timeScale: "month" },
            )
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              padding: "8px",
            });
        },
      },
      {
        title: "Long Title - Text truncation with ellipsis",
        render: () => {
          return EntryRow.make()
            .bind(
              {
                title:
                  "Weekly Engineering Sync: Infrastructure Updates, Security Patches, and Performance Optimizations Discussion",
                accentColor: "var(--green)",
                at: exampleTime,
                timezone,
              },
              { ...EntryDisplay.DEFAULT, timeScale: "year" },
            )
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              padding: "8px",
            });
        },
      },
    ];
  }
}
