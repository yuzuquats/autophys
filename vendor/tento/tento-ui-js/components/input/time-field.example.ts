import { TimeOfDay } from "@tento-chrono";
import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Toast } from "../toast/toast";
import { TimeField } from "./time-field";

export class TimeFieldStoryBook extends Storybook.Default {
  title(): string {
    return "Time Field";
  }

  tags(): string[] {
    return ["std-time-field", "std-time-field-dropdown"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $timeField = TimeField.makeWith({
            placeholder: "HH:MM",
            onChange: (time) => {
              Toast.info(`Selected time: ${TimeOfDay.Formatter.render(time)}`);
            },
          });

          return $timeField;
        },
      },
      {
        title: "Basic Time Field",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";

          const $timeField = TimeField.makeWith({
            placeholder: "HH:MM",
            onChange: (time) => {
              Toast.info(`Selected time: ${TimeOfDay.Formatter.render(time)}`);
            },
            onInvalid: (message) => {
              Toast.error(message);
            },
          });

          $container.appendChild($timeField);

          return $container;
        },
      },
      {
        title: "With Initial Value",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";

          const $label = Typography.p("Meeting time:");
          $container.appendChild($label);

          const $timeField = TimeField.makeWith({
            value: TimeOfDay.wrap({ hrs: 14.5 }), // 2:30 PM
            onChange: (time) => {
              Toast.info(`Changed to: ${TimeOfDay.Formatter.render(time)}`);
            },
          }).assignStyles({
            width: "160px",
          });

          $container.appendChild($timeField);

          return $container;
        },
      },
      {
        title: "Multiple Time Fields",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "20px";

          // Start time
          const $startSection = Column.make();
          $startSection.style.gap = "8px";
          const $startLabel = Typography.small("Start time:");
          $startSection.appendChild($startLabel);

          const $startField = TimeField.makeWith({
            placeholder: "HH:MM",
            onChange: (time) => {
              Toast.info(`Start: ${TimeOfDay.Formatter.render(time)}`);
            },
          });
          $startSection.appendChild($startField);

          // End time
          const $endSection = Column.make();
          $endSection.style.gap = "8px";
          const $endLabel = Typography.small("End time:");
          $endSection.appendChild($endLabel);

          const $endField = TimeField.makeWith({
            placeholder: "HH:MM",
            onChange: (time) => {
              Toast.info(`End: ${TimeOfDay.Formatter.render(time)}`);
            },
          });
          $endSection.appendChild($endField);

          $container.appendChild($startSection);
          $container.appendChild($endSection);

          return $container;
        },
      },
    ];
  }
}
