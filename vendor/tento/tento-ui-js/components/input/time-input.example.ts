import { TimeOfDay } from "@tento-chrono";
import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Toast } from "../toast/toast";
import { TimeInput } from "./time-input";

export class TimeInputStoryBook extends Storybook.Default {
  title(): string {
    return "Time Input";
  }

  tags(): string[] {
    return ["std-time-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic TimeInput with Label",
        render: () => {
          const $timeInput = TimeInput.makeWith({
            label: "Meeting Time",
            placeholder: "HH:MM",
            helperText: "Select the meeting start time",
            onChange: (time) => {
              Toast.info(`Selected time: ${TimeOfDay.Formatter.render(time)}`);
            },
          });

          return $timeInput;
        },
      },
      {
        title: "Required TimeInput",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";

          const $timeInput = TimeInput.makeWith({
            label: "Appointment Time",
            placeholder: "HH:MM",
            required: true,
            onChange: (time) => {
              Toast.info(`Selected time: ${TimeOfDay.Formatter.render(time)}`);
            },
            onInvalid: (message) => {
              Toast.error(message);
            },
          });

          $container.appendChild($timeInput);

          return $container;
        },
      },
      {
        title: "With Initial Value",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";

          const $timeInput = TimeInput.makeWith({
            label: "Default Meeting Time",
            value: TimeOfDay.wrap({ hrs: 14.5 }), // 2:30 PM
            helperText: "This is the default time for meetings",
            onChange: (time) => {
              Toast.info(`Changed to: ${TimeOfDay.Formatter.render(time)}`);
            },
          });

          $container.appendChild($timeInput);

          return $container;
        },
      },
      {
        title: "Multiple Time Inputs",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "20px";

          const $startInput = TimeInput.makeWith({
            label: "Start Time",
            placeholder: "HH:MM",
            required: true,
            onChange: (time) => {
              Toast.info(`Start: ${TimeOfDay.Formatter.render(time)}`);
            },
          });
          $container.appendChild($startInput);

          const $endInput = TimeInput.makeWith({
            label: "End Time",
            placeholder: "HH:MM",
            required: true,
            onChange: (time) => {
              Toast.info(`End: ${TimeOfDay.Formatter.render(time)}`);
            },
          });
          $container.appendChild($endInput);

          return $container;
        },
      },
    ];
  }
}
