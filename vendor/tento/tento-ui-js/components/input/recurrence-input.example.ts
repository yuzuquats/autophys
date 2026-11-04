import { NaiveDate } from "@tento-chrono";
import { Storybook } from "../../ui/storybook";
import { RecurrenceInput } from "./recurrence-input";
import { Toast } from "../toast/toast";

export class RecurrenceInputStoryBook extends Storybook.Default {
  title(): string {
    return "Recurrence Input";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Recurrence Input",
        render: () => {
          const referenceDate = NaiveDate.today();
          const $input = RecurrenceInput.makeWith({
            referenceDate,
            onChange: (model) => {
              if (!model) return;
              const rrule = $input.modelToRRule(model);
              Toast.info("Recurrence Changed", {
                description: rrule.toReadableDisplay(),
              });
            },
          });
          return $input.assignStyles({
            width: "100%",
          });
        },
      },
      {
        title: "Recurrence Input",
        render: () => {
          const referenceDate = NaiveDate.today();
          const $input = RecurrenceInput.makeWith({
            referenceDate,
            onChange: (model) => {
              if (!model) return;
              const rrule = $input.modelToRRule(model);
              $status.bindText([
                `Reference Date: ${referenceDate.toString()}`,
                rrule.toString(),
                rrule.toReadableDisplay(),
              ]);
            },
          });
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText(`Reference Date: ${referenceDate.toString()}`);
          return {
            $content: $input.assignStyles({
              width: "100%",
            }),
            $status,
          };
        },
      },
    ];
  }
}
