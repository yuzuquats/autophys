import { DateTime, Duration, Local, NaiveTime } from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { EventDetailsTimeLabel } from "./event-details-time-label";

export class EventDetailsTimeLabelStoryBook extends Storybook.Default {
  title(): string {
    return "Event Details Time Label";
  }

  examples(): Storybook.Example[] {
    const now = Local.now().nearest(Duration.Time.MIN15);

    return [
      {
        title: "Same-day timed",
        render: async () => {
          const $c = EventDetailsTimeLabel.make();
          const start = now;
          $c.bind(
            new DateTime.Range(start, start.add({ hrs: 8 })),
          );
          return $c;
        },
      },
      {
        title: "Same-day all-day",
        render: async () => {
          const $c = EventDetailsTimeLabel.make();
          const start = now.withTime(NaiveTime.ZERO);
          $c.bind(
            new DateTime.Range(start, start.add({ days: 1 })),
            true,
          );
          return $c;
        },
      },
      {
        title: "Multi-day timed, same month",
        render: async () => {
          const $c = EventDetailsTimeLabel.make();
          const start = now.withTime(NaiveTime.fromHms({ hrs: 9 }));
          const end = now.add({ days: 2 }).withTime(NaiveTime.fromHms({ hrs: 17 }));
          $c.bind(new DateTime.Range(start, end));
          return $c;
        },
      },
      {
        title: "Multi-day timed, different months",
        render: async () => {
          const $c = EventDetailsTimeLabel.make();
          const start = now.withTime(NaiveTime.fromHms({ hrs: 9 }));
          const end = now.add({ days: 30 }).withTime(NaiveTime.fromHms({ hrs: 17 }));
          $c.bind(new DateTime.Range(start, end));
          return $c;
        },
      },
      {
        title: "Multi-day all-day, same month",
        render: async () => {
          const $c = EventDetailsTimeLabel.make();
          const start = now.withTime(NaiveTime.ZERO);
          const end = start.add({ days: 3 });
          $c.bind(new DateTime.Range(start, end), true);
          return $c;
        },
      },
      {
        title: "Multi-day all-day, different months",
        render: async () => {
          const $c = EventDetailsTimeLabel.make();
          const start = now.withTime(NaiveTime.ZERO);
          const end = start.add({ days: 31 });
          $c.bind(new DateTime.Range(start, end), true);
          return $c;
        },
      },
    ];
  }
}
