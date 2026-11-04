import { Duration } from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { WeeklySchedule } from "./weekly-schedule";
import { Round } from "../round";
import { BrowserChrome } from "../browser-chrome";

export class WeeklyScheduleStoryBook extends Storybook.Default {
  title(): string {
    return "Weekly Schedule";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $schedule = WeeklySchedule.make();
          const controller = $schedule.controller;
          controller.state.addListener({}, (_state) => {
            // const blockCount = state.timeBlocks.length;
          });
          controller.createTimeBlock(
            1,
            Duration.Time.from({ hrs: 9 }),
            Duration.Time.from({ hrs: 10 }),
          );
          controller.createTimeBlock(
            2,
            Duration.Time.from({ hrs: 14, mins: 30 }),
            Duration.Time.from({ hrs: 16 }),
          );
          controller.createTimeBlock(
            3,
            Duration.Time.from({ hrs: 8, mins: 45 }),
            Duration.Time.from({ hrs: 11, mins: 15 }),
          );

          return BrowserChrome.makeExample(
            Round.makeWithContent(
              $schedule.assignStyles({
                flex: "1",
                height: "600px",
                alignSelf: "stretch",
                borderRadius: "24px",
                overflow: "hidden",
              }),
              Round.Props.MODAL,
            ).assignStyles({}),
            "ui.lona.so/schedule",
          );
        },
      },
    ];
  }
}
