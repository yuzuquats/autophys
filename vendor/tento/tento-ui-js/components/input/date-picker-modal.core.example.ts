// The modal imports DatePicker for its type only, so nothing it pulls in
// registers <std-date-picker>; a card bundled on its own must do that.
import "../controls/date-picker";

import { NaiveDate } from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { DatePickerInput } from "./date-picker-input";
import { DatePickerModal } from "./date-picker-modal";

// The modal is an ordinary element until something reveals it, so it can be
// bound and shown inline. Select calls back and then asks the overlay to
// dismiss it — a no-op for an element that was never revealed, so the inline
// copy stays put and can commit again. Cancel only dismisses, so inline it
// does nothing; the overlay examples show it.

function describe(date: Option<NaiveDate>): string {
  if (!date) return "No date";
  return `${date.dayOfWeek.shortname}, ${date.format()}`;
}

function $statusLine(text: string): Storybook.Card.StatusLine {
  const $status = Storybook.Card.StatusLine.make();
  $status.style.minHeight = "unset";
  $status.bindText(text);
  return $status;
}

function $inline(
  title: string,
  date: Option<NaiveDate>,
  onDateSelected: (date: Option<NaiveDate>) => void,
): DatePickerModal {
  const $modal = DatePickerModal.make();
  $modal.bind(title, date, onDateSelected);
  // The card stretches its subject to the card's measure; keep the modal at
  // its own 320px so it reads as the dialog it is.
  $modal.style.setProperty("--storybook-card-content-max-width", "320px");
  return $modal;
}

export class CoreDatePickerModalStoryBook extends Storybook.Default {
  title(): string {
    return "Date Picker Modal";
  }

  tags(): string[] {
    return ["std-date-picker-modal"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Pick a day, then Select commits it",
        render: () => {
          const due = NaiveDate.today().addDays(3);
          const $status = $statusLine(`Due ${describe(due)}`);
          const $content = $inline("Due date", due, (date) => {
            $status.bindText(`Due ${describe(date)}`);
          });
          return { $content, $status };
        },
      },
      {
        title: "Opened over the page — Cancel keeps the previous date",
        render: () => {
          let start: Option<NaiveDate> = NaiveDate.today();
          const $status = $statusLine(`Starts ${describe(start)}`);
          const $content = Button.makeWith("Change start date", {
            type: "primary",
            onClick: () => {
              void DatePickerModal.show("Start date", start, (date) => {
                start = date;
                $status.bindText(`Starts ${describe(start)}`);
              });
            },
          });
          return { $content, $status };
        },
      },
      {
        // With no current date the calendar highlights today, but nothing is
        // chosen until a day is clicked: Select straight away commits none.
        title: "No date yet — the calendar opens on today",
        render: () => {
          const $status = $statusLine("No reminder set");
          const $content = $inline("Remind me on", null, (date) => {
            $status.bindText(
              date ? `Reminder on ${describe(date)}` : "Committed no date",
            );
          });
          return { $content, $status };
        },
      },
      {
        title: "A date months away opens on its own month",
        render: () => {
          const renewal = NaiveDate.today().addDays(150);
          const $status = $statusLine(`Renews ${describe(renewal)}`);
          const $content = $inline("Renewal date", renewal, (date) => {
            $status.bindText(`Renews ${describe(date)}`);
          });
          return { $content, $status };
        },
      },
      {
        // The usual caller: the field shows a relative label ("Tomorrow",
        // "Next Fri") and opens this modal on click.
        title: "Opened by std-date-picker-input",
        render: () => {
          const tomorrow = NaiveDate.today().addDays(1);
          const $status = $statusLine(describe(tomorrow));
          const $content = DatePickerInput.makeWith({
            date: tomorrow,
            modalTitle: "Due date",
            onChange: (date) => $status.bindText(describe(date)),
          });
          return { $content, $status };
        },
      },
    ];
  }
}
