import { Duration } from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { TimerDisplay } from "./timer-display";
import { Timer } from "./timer";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { PropertyList } from "../input/property-list";

export class TimerDisplayStoryBook extends Storybook.Default {
  title(): string {
    return "Timer Display";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Interactive (Headless Timer)",
        render: () => {
          const status: string[] = ["", ""];
          const $status = Storybook.Card.StatusLine.make();

          const timer = Timer.make(Duration.Time.mins(10));
          const $timer = TimerDisplay.make()
            .bind({
              onPendingDurationChange: (d) => {
                status[0] = `Pending: ${d?.dbg() ?? "<None>"}`;
                $status.bindText(status);
              },
              onDurationChange: (d) => {
                status[1] = `Duration: ${d?.dbg() ?? "<None>"}`;
                $status.bindText(status);
              },
            })
            .bindTimer(timer);

          const $startBtn = Button.makeWithLight("Start Timer", {
            type: "primary",
            size: "thin",
          });
          const $resetBtn = Button.makeWithLight("Reset", {
            type: "secondary",
            size: "thin",
          });

          timer.subscribe({
            onStateChange: (state) => {
              $startBtn.textContent =
                state.state === "running" ? "Pause" : "Start Timer";
              if (state.state === "finished") {
                status[0] = "Timer complete!";
                $status.bindText(status);
              }
            },
          });

          GESTURE_MANAGER.addPointerEvent($startBtn, {
            onClick: () => {
              const state = timer.getSimpleState();
              if (state === "running") {
                timer.pause();
              } else {
                timer.start();
              }
            },
          });

          GESTURE_MANAGER.addPointerEvent($resetBtn, {
            onClick: () => {
              timer.reset();
            },
          });

          const $controls = PropertyList.makeWith({
            timerControl: {
              label: "Timer Control",
              $e: $startBtn,
              order: 0,
            },
            resetControl: {
              label: "Reset",
              $e: $resetBtn,
              order: 1,
            },
          });

          return {
            $content: $timer,
            $status,
            $controls,
          };
        },
      },
      {
        title: "Multiple Displays (1:N Binding)",
        render: () => {
          const timer = Timer.make(Duration.Time.mins(5));

          const $display1 = TimerDisplay.make().bindTimer(timer);
          const $display2 = TimerDisplay.make().bindTimer(timer);

          $display1.style.marginRight = "24px";

          const $container = document.createElement("std-row");
          $container.appendChild($display1);
          $container.appendChild($display2);

          const $startBtn = Button.makeWithLight("Start", {
            type: "primary",
            size: "thin",
          });
          const $pauseBtn = Button.makeWithLight("Pause", {
            type: "secondary",
            size: "thin",
          });
          const $resetBtn = Button.makeWithLight("Reset", {
            type: "secondary",
            size: "thin",
          });

          GESTURE_MANAGER.addPointerEvent($startBtn, {
            onClick: () => timer.start(),
          });
          GESTURE_MANAGER.addPointerEvent($pauseBtn, {
            onClick: () => timer.pause(),
          });
          GESTURE_MANAGER.addPointerEvent($resetBtn, {
            onClick: () => timer.reset(),
          });

          return {
            $content: $container,
            $controls: PropertyList.makeWith({
              start: { label: "Start", $e: $startBtn, order: 0 },
              pause: { label: "Pause", $e: $pauseBtn, order: 1 },
              reset: { label: "Reset", $e: $resetBtn, order: 2 },
            }),
          };
        },
      },
      {
        title: "Editable Timer Label",
        render: () => {
          const timer = Timer.make(Duration.Time.mins(25));
          return TimerDisplay.make()
            .bind({
              onDurationChange: (duration) => {
                console.log(
                  `Duration changed to: ${TimerDisplay.formatDisplayTime(duration)}`,
                );
              },
            })
            .bindTimer(timer);
        },
      },
    ];
  }
}
