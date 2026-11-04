import { NaiveDate } from "@tento-chrono";
import { Button } from "../components/button/button";
import { DatePicker } from "../components/controls/date-picker";
import { Storybook } from "../ui/storybook";
import { Pip } from "./pip";

Pip.components.add(DatePicker);

export class PipStoryBook extends Storybook.Default {
  title(): string {
    return "Picture in Picture";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          return Button.makeWithLight("Show Picture in Picture", {
            type: "primary",
            onClick: () => {
              const $d = DatePicker.make();
              $d.bindToDate(NaiveDate.today(), NaiveDate.today());
              Pip.show($d, {
                margin: "20px",
                size: {
                  width: 276,
                  height: 309,
                },
              });
            },
          });
        },
      },
    ];
  }
}
