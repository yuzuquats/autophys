import { TimeOfDay } from "@tento-chrono";
import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { TimePicker } from "./time-picker";

export class CoreTimePickerStoryBook extends Storybook.Default {
  title(): string {
    return "Time Picker";
  }

  tags(): string[] {
    return ["std-time-picker"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Start time — pick a slot or type “2:30pm”",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $picker = TimePicker.make();
          // Typed times need am/pm and must land on a quarter hour to match a
          // slot; "2:30pm" selects, "14:30" and "2:10pm" do not.
          $picker.onSelected = (time) =>
            $status.bindText(`Starts at ${CoreTimePickerStoryBook.label(time)}`);
          $picker.bind(TimeOfDay.wrap({ hrs: 9 }));
          return { $content: CoreTimePickerStoryBook.$frame($picker), $status };
        },
      },
      {
        title: "Working hours only — onPending rejects other times",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $picker = TimePicker.make();
          // Returning a string refuses the time and shows it as the error
          // tooltip; the previous selection stays.
          $picker.onPending = (time) =>
            time.hrs < 9 || time.hrs >= 18
              ? "Outside working hours (9 AM – 6 PM)"
              : time;
          $picker.onSelected = (time) =>
            $status.bindText(`Meeting at ${CoreTimePickerStoryBook.label(time)}`);
          $picker.bind(TimeOfDay.wrap({ hrs: 10 }));
          return { $content: CoreTimePickerStoryBook.$frame($picker), $status };
        },
      },
      {
        title: "Whole hours only — onPending rounds down",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $picker = TimePicker.make();
          // Returning a different TimeOfDay selects that one instead, so
          // clicking 3:45 PM lands on 3:00 PM.
          $picker.onPending = (time) => TimeOfDay.wrap({ hrs: time.hrs });
          $picker.onSelected = (time) =>
            $status.bindText(`Check-in ${CoreTimePickerStoryBook.label(time)}`);
          $picker.bind(TimeOfDay.wrap({ hrs: 15 }));
          return { $content: CoreTimePickerStoryBook.$frame($picker), $status };
        },
      },
      {
        title: "No time yet — the field shows its placeholder",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("No time chosen");

          const $picker = TimePicker.make();
          $picker.onSelected = (time) =>
            $status.bindText(`Chosen ${CoreTimePickerStoryBook.label(time)}`);
          return { $content: CoreTimePickerStoryBook.$frame($picker), $status };
        },
      },
    ];
  }

  /** The picker's list fills its host's height and scrolls inside it, so the
   * host needs a block box and a definite height; the typed field stays
   * pinned above the list. */
  private static $frame($picker: TimePicker): HTMLElement {
    $picker.assignStyles({ display: "block", height: "280px" });
    const $frame = Column.make();
    $frame.assignStyles({ alignItems: "center" });
    $frame.appendChild($picker);
    return $frame;
  }

  private static label(time: TimeOfDay): string {
    return time.format({
      includeAmPm: true,
      includeSeconds: false,
      padHours: false,
      allCaps: true,
    });
  }
}
