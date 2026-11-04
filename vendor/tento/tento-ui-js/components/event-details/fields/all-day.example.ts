import { Storybook } from "../../../ui/storybook";
import { EventDetailsFieldAllDay } from "./all-day";

export class AllDayFieldStoryBook extends Storybook.Default {
  title(): string {
    return "All-Day Field";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default (Off)",
        render: () => {
          return EventDetailsFieldAllDay.make().assignStyles({
            width: "100%",
            maxWidth: "360px",
          });
        },
      },
      {
        title: "Initially On",
        render: () => {
          const field = EventDetailsFieldAllDay.make().assignStyles({
            width: "100%",
            maxWidth: "360px",
          });
          field.$content.bind(
            (enabled) => {
              console.log("All-day toggled:", enabled);
            },
            true,
          );
          return field;
        },
      },
      {
        title: "With Change Handler",
        render: () => {
          const field = EventDetailsFieldAllDay.make().assignStyles({
            width: "100%",
            maxWidth: "360px",
          });
          field.$content.bind(
            (enabled) => {
              console.log("All-day changed to:", enabled);
            },
            false,
          );
          return field;
        },
      },
    ];
  }
}
