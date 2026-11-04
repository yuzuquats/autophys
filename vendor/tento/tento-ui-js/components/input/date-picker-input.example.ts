import { NaiveDate } from "@tento-chrono";
import { Column, Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { DatePickerInput } from "./date-picker-input";
import { Toast } from "../toast/toast";

function toast(date: Option<NaiveDate>) {
  Toast.info(date?.toString() ?? "No date selected");
}

export class DatePickerInputStoryBook extends Storybook.Default {
  title(): string {
    return "Date Picker Input";
  }

  tags(): string[] {
    return ["std-date-picker-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Date Picker Input",
        render: () => {
          return DatePickerInput.makeWith({
            placeholder: "Select a date",
          }).bind({
            onChange: toast,
          });
        },
      },
      {
        title: "With initial date",
        render: () => {
          return DatePickerInput.makeWith({
            date: NaiveDate.today(),
            placeholder: "Select a date",
            onChange: toast,
          });
        },
      },
      {
        title: "Relative date examples",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "12px";

          const today = NaiveDate.today();
          const examples = [
            { days: 0, label: "Today" },
            { days: 1, label: "Tomorrow" },
            { days: -1, label: "Yesterday" },
            { days: 3, label: "3 days from now" },
            { days: -3, label: "3 days ago" },
            { days: 10, label: "Next week+" },
            { days: -10, label: "Last week+" },
            { days: 30, label: "Next month" },
            { days: -30, label: "Last month" },
            { days: 365, label: "Next year" },
          ];

          for (const example of examples) {
            const $row = Row.make();
            $row.style.gap = "16px";
            $row.style.alignItems = "center";

            const $label = Typography.caption(example.label);
            $label.style.width = "120px";
            $label.style.color = "var(--text-sec)";

            const $input = DatePickerInput.makeWith({
              date: today.add({ days: example.days }),
              placeholder: "Select date",
            });

            $row.appendChild($label);
            $row.appendChild($input);
            $container.appendChild($row);
          }

          return $container;
        },
      },
    ];
  }
}
