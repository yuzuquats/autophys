import { NaiveDate } from "@tento-chrono";
import { Column } from "../../component-builtin";
import { Tracing } from "@tento-core/tracing";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { DateField } from "./date-field";

export class DateFieldStoryBook extends Storybook.Default {
  title(): string {
    return "Date Field";
  }

  tags(): string[] {
    return ["std-date-field", "std-date-field-dropdown"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic DateField",
        render: () => {
          return DateField.makeWith({
            placeholder: "YYYY-MM-DD",
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Date changed:", date?.toString());
            },
          });
        },
      },
      {
        title: "With Initial Value",
        render: () => {
          const $container = Column.make();
          $container.style.padding = "20px";
          $container.style.gap = "16px";

          const $label = Typography.p("Date Field with Initial Value:");
          $container.appendChild($label);

          const $field = DateField.makeWith({
            value: NaiveDate.today(),
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Date changed:", date?.toString());
            },
          });
          $container.appendChild($field);

          return $container;
        },
      },
      {
        title: "With Min/Max Constraints",
        render: () => {
          const $container = Column.make();
          $container.style.padding = "20px";
          $container.style.gap = "16px";

          const $label = Typography.p("Date Field with Constraints:");
          $container.appendChild($label);

          const today = NaiveDate.today();
          const minDate = today.addDays(-30);
          const maxDate = today.addDays(30);

          const $field = DateField.makeWith({
            placeholder: "Select date within ±30 days",
            min: minDate,
            max: maxDate,
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Date changed:", date?.toString());
            },
            onInvalid: (message: string) => {
              Tracing.dev("Invalid date:", message);
            },
          });
          $container.appendChild($field);

          const $info = Typography.small(
            `Min: ${minDate.toString()} | Max: ${maxDate.toString()}`,
          );
          $info.style.color = "var(--text-sec)";
          $container.appendChild($info);

          return $container;
        },
      },
      {
        title: "Multiple Date Fields",
        render: () => {
          const $container = Column.make();
          $container.style.padding = "20px";
          $container.style.gap = "24px";

          const $title = Typography.h6("Date Range Selection");
          $container.appendChild($title);

          const $rangeContainer = Column.make();
          $rangeContainer.style.gap = "12px";

          const $startLabel = Typography.small("Start Date:");
          $rangeContainer.appendChild($startLabel);

          const $startField = DateField.makeWith({
            placeholder: "Start date",
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Start date:", date?.toString());
            },
          });
          $rangeContainer.appendChild($startField);

          const $endLabel = Typography.small("End Date:");
          $rangeContainer.appendChild($endLabel);

          const $endField = DateField.makeWith({
            placeholder: "End date",
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("End date:", date?.toString());
            },
          });
          $rangeContainer.appendChild($endField);

          $container.appendChild($rangeContainer);

          return $container;
        },
      },
    ];
  }
}
