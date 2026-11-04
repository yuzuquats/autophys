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
import { DateTimeInput } from "./datetime-input";
import { Toast } from "../toast/toast";

export class DateTimeInputStoryBook {
  title() {
    return "DateTime Input";
  }

  tags(): string[] {
    return [];
  }

  preview() {
    return {
      title: "DateTime Input Preview",
      render: () => {
        return DateTimeInput.makeWith({
          label: "Event Date & Time",
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
        title: "Basic DateTime Input with Label",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const $input = DateTimeInput.makeWith({
            label: "Event Date & Time",
            helperText: "Select when the event starts",
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

          $container.appendChild($input);
          $container.appendChild($result);

          return $container;
        },
      },
      {
        title: "Required DateTime Input",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";
          $container.style.padding = "20px";

          const $input = DateTimeInput.makeWith({
            label: "Appointment",
            required: true,
            onChange: (datetime) => {
              $result.textContent = `Selected: ${datetime.toString()}`;
            },
          });

          const $result = Typography.p("No datetime selected yet");
          $result.style.marginTop = "12px";

          $container.appendChild($input);
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

          const $input = DateTimeInput.makeWith({
            label: "Meeting Time",
            value: initialDateTime,
            helperText: "Modify the meeting time",
            onChange: (datetime) => {
              $result.textContent = `Selected: ${datetime.toString()}`;
            },
          });

          const $result = Typography.p(
            `Initial: ${initialDateTime.toString()}`,
          );
          $result.style.marginTop = "12px";

          $container.appendChild($input);
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

          const $input = DateTimeInput.makeWith({
            label: "Deadline",
            datePlaceholder: "Pick a date",
            timePlaceholder: "Pick a time",
            helperText: "When is the deadline?",
            onChange: (datetime) => {
              $result.textContent = `Selected: ${datetime.toString()}`;
            },
          });

          const $result = Typography.p("No datetime selected yet");
          $result.style.marginTop = "12px";

          $container.appendChild($input);
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

          const $input = DateTimeInput.makeWith({
            label: "Booking Time",
            helperText: "Select a valid date and time",
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

          $container.appendChild($input);
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

          let $input = DateTimeInput.makeWith({
            label: "Scheduled Time",
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
              const newInput = DateTimeInput.makeWith({
                label: "Scheduled Time",
                value: currentDateTime,
                onChange: (datetime) => {
                  $result.textContent = `Selected: ${datetime.toString()}`;
                },
              });
              $input.replaceWith(newInput);
              $input = newInput;
              $result.textContent = `Set to: ${currentDateTime.toString()}`;
            },
          });

          const $clearBtn = Button.makeWithLight("Clear", {
            type: "secondary",
            onClick: () => {
              // Re-create without value
              const newInput = DateTimeInput.makeWith({
                label: "Scheduled Time",
                onChange: (datetime) => {
                  $result.textContent = `Selected: ${datetime.toString()}`;
                },
              });
              $input.replaceWith(newInput);
              $input = newInput;
              $result.textContent = "Cleared";
            },
          });

          $buttonRow.appendChild($setNowBtn);
          $buttonRow.appendChild($clearBtn);

          const $result = Typography.p("No datetime selected yet");
          $result.style.marginTop = "12px";

          $container.appendChild($input);
          $container.appendChild($buttonRow);
          $container.appendChild($result);

          return $container;
        },
      },
    ];
  }
}
