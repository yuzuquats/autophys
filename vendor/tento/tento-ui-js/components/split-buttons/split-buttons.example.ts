import { CSSLength } from "@tento-ui/css-length";
import { Storybook } from "../../ui/storybook";
import { SplitButtons } from "./split-buttons";

export class SplitButtonsStoryBook extends Storybook.Default {
  title(): string {
    return "Split Buttons";
  }

  tags(): string[] {
    return ["std-split-buttons"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Half",
        render: () =>
          SplitButtons.make().bind({ selected: CSSLength.fromVw(50) }),
      },
      {
        title: "Two thirds",
        render: () =>
          SplitButtons.make().bind({ selected: CSSLength.fromVw(66) }),
      },
    ];
  }
}
