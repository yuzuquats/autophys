import { NaiveDate } from "@tento-chrono";
import { Column } from "../../component-builtin";
import { Tracing } from "@tento-core/tracing";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { DateInput } from "./date-input";

export class DateInputStoryBook extends Storybook.Default {
  title(): string {
    return "Date Input";
  }

  tags(): string[] {
    return ["std-date-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic DateInput with Label",
        render: () => {
          return DateInput.makeWith({
            label: "Date of Birth",
            placeholder: "YYYY-MM-DD",
            helperText: "Enter your date of birth",
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Date changed:", date?.toString());
            },
          });
        },
      },
      {
        title: "Required DateInput",
        render: () => {
          const $container = Column.make();
          $container.style.padding = "20px";
          $container.style.gap = "16px";

          const $input = DateInput.makeWith({
            label: "Start Date",
            required: true,
            placeholder: "Select a date",
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Date changed:", date?.toString());
            },
          });
          $container.appendChild($input);

          return $container;
        },
      },
      {
        title: "With Initial Value",
        render: () => {
          const $container = Column.make();
          $container.style.padding = "20px";
          $container.style.gap = "16px";

          const $input = DateInput.makeWith({
            label: "Event Date",
            value: NaiveDate.today(),
            helperText: "The date of the event",
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Date changed:", date?.toString());
            },
          });
          $container.appendChild($input);

          return $container;
        },
      },
      {
        title: "With Min/Max Constraints",
        render: () => {
          const $container = Column.make();
          $container.style.padding = "20px";
          $container.style.gap = "16px";

          const today = NaiveDate.today();
          const minDate = today.addDays(-30);
          const maxDate = today.addDays(30);

          const $input = DateInput.makeWith({
            label: "Appointment Date",
            placeholder: "Select date within ±30 days",
            min: minDate,
            max: maxDate,
            helperText: `Available: ${minDate.toString()} to ${maxDate.toString()}`,
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Date changed:", date?.toString());
            },
            onInvalid: (message: string) => {
              Tracing.dev("Invalid date:", message);
            },
          });
          $container.appendChild($input);

          return $container;
        },
      },
      {
        title: "Multiple Date Inputs",
        render: () => {
          const $container = Column.make();
          $container.style.padding = "20px";
          $container.style.gap = "24px";

          const $title = Typography.h6("Date Range Selection");
          $container.appendChild($title);

          const $startInput = DateInput.makeWith({
            label: "Start Date",
            placeholder: "Start date",
            required: true,
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("Start date:", date?.toString());
            },
          });
          $container.appendChild($startInput);

          const $endInput = DateInput.makeWith({
            label: "End Date",
            placeholder: "End date",
            required: true,
            onChange: (date: Option<NaiveDate>) => {
              Tracing.dev("End date:", date?.toString());
            },
          });
          $container.appendChild($endInput);

          return $container;
        },
      },
    ];
  }
}
