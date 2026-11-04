import {
  DateTime,
  NaiveDate,
  NaiveDateTime,
  TimeOfDay,
  Utc,
} from "@tento-chrono";
import { Column, Row } from "../../component-builtin";
import { Tracing } from "@tento-core/tracing";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { DateTimeField } from "./datetime-field";
import { Toast } from "../toast/toast";

export class DateTimeFieldStoryBook {
  title() {
    return "DateTime Field";
  }

  tags(): string[] {
    return [];
  }

  preview() {
    return {
      title: "DateTime Field Preview",
      render: () => {
        return DateTimeField.makeWith({
          onChange: (datetime) => {
            Toast.info("Preview datetime selected:", {
              description: datetime.toString(),
            });
          },
        });
      },
    };
  }

  examples() {
    return [
      {
        title: "Basic DateTime Field",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const $field = DateTimeField.makeWith({
            onChange: (datetime) => {
              $result.textContent = `Selected: ${datetime.toString()}`;
              Tracing.dev("DateTime selected:", datetime.toString());
            },
            onInvalid: (message) => {
              $result.textContent = `Invalid: ${message}`;
              Tracing.dev("Invalid input:", message);
            },
          });

          const $result = Typography.p("No datetime selected yet");
          $result.style.marginTop = "12px";

          $container.appendChild($field);
          $container.appendChild($result);

          return $container;
        },
      },
      {
        title: "With Initial Value",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const now = DateTime.utc.now();
          const initialDateTime = new NaiveDateTime(now.date, now.time);

          const $field = DateTimeField.makeWith({
            value: initialDateTime,
            onChange: (datetime) => {
              $result.textContent = `Selected: ${datetime.toString()}`;
            },
          });

          const $result = Typography.p(
            `Initial: ${initialDateTime.toString()}`,
          );
          $result.style.marginTop = "12px";

          $container.appendChild($field);
          $container.appendChild($result);

          return $container;
        },
      },
      {
        title: "Custom Placeholders",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const $field = DateTimeField.makeWith({
            datePlaceholder: "Pick a date",
            timePlaceholder: "Pick a time",
            onChange: (datetime) => {
              $result.textContent = `Selected: ${datetime.toString()}`;
            },
          });

          const $result = Typography.p("No datetime selected yet");
          $result.style.marginTop = "12px";

          $container.appendChild($field);
          $container.appendChild($result);

          return $container;
        },
      },
      {
        title: "Without Chevrons",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const $field = DateTimeField.makeWith({
            showDateChevron: false,
            showTimeChevron: false,
            onChange: (datetime) => {
              $result.textContent = `Selected: ${datetime.toString()}`;
            },
          });

          const $result = Typography.p("No datetime selected yet");
          $result.style.marginTop = "12px";

          $container.appendChild($field);
          $container.appendChild($result);

          return $container;
        },
      },
      {
        title: "With Validation",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const $field = DateTimeField.makeWith({
            onChange: (datetime) => {
              $validation.textContent = `Valid: ${datetime.toString()}`;
              $validation.style.color = "var(--green)";
            },
            onInvalid: (message) => {
              $validation.textContent = message;
              $validation.style.color = "var(--red)";
            },
          });

          const $validation = Typography.p("Enter a date and time");
          $validation.style.marginTop = "12px";

          $container.appendChild($field);
          $container.appendChild($validation);

          return $container;
        },
      },
      {
        title: "Programmatic Control",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          let $field = DateTimeField.makeWith({
            onChange: (datetime) => {
              $result.textContent = `Selected: ${datetime.toString()}`;
            },
          });

          const $buttonRow = Row.make();
          $buttonRow.style.gap = "8px";

          const $setNowBtn = Button.makeWithLight("Set to Now", {
            onClick: () => {
              // Re-create with new value
              const now = DateTime.utc.now();
              const currentDateTime = new NaiveDateTime(now.date, now.time);
              const newField = DateTimeField.makeWith({
                value: currentDateTime,
                onChange: (datetime) => {
                  $result.textContent = `Selected: ${datetime.toString()}`;
                },
              });
              $field.replaceWith(newField);
              $field = newField;
              $result.textContent = `Set to: ${currentDateTime.toString()}`;
            },
          });

          const $clearBtn = Button.makeWithLight("Clear", {
            type: "secondary",
            onClick: () => {
              // Re-create without value
              const newField = DateTimeField.makeWith({
                onChange: (datetime) => {
                  $result.textContent = `Selected: ${datetime.toString()}`;
                },
              });
              $field.replaceWith(newField);
              $field = newField;
              $result.textContent = "Cleared";
            },
          });

          $buttonRow.appendChild($setNowBtn);
          $buttonRow.appendChild($clearBtn);

          const $result = Typography.p("No datetime selected yet");
          $result.style.marginTop = "12px";

          $container.appendChild($field);
          $container.appendChild($buttonRow);
          $container.appendChild($result);

          return $container;
        },
      },
    ];
  }
}
