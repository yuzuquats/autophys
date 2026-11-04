import { Duration } from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { TimerControls } from "./timer-controls";
import { TimerDisplay } from "./timer-display";
import { Timer } from "./timer";

export class TimerControlsStoryBook extends Storybook.Default {
  title(): string {
    return "Timer Controls";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic Controls",
        render: () => {
          const status: string[] = ["State: not-started"];
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText(status);

          const timer = Timer.make(Duration.Time.mins(5));
          const $controls = TimerControls.make();
          $controls.bindTimer(timer);

          timer.subscribe({
            onStateChange: (state) => {
              status[0] = `State: ${state.state}`;
              $status.bindText(status);
            },
          });

          return {
            $content: $controls,
            $status,
          };
        },
      },
      {
        title: "With Timer Display",
        render: () => {
          const timer = Timer.make(Duration.Time.secs(10));

          const $display = TimerDisplay.make().bindTimer(timer);
          const $controls = TimerControls.make();
          $controls.bindTimer(timer);

          const $container = document.createElement("std-col");
          $container.style.gap = "16px";
          $container.style.alignItems = "center";
          $container.appendChild($display);
          $container.appendChild($controls);

          $controls.style.width = "200px";

          return $container;
        },
      },
    ];
  }
}
