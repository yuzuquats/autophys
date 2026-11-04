import { Storybook } from "../../ui/storybook";
import { Blockquote } from "./blockquote";

export class BlockquoteStoryBook extends Storybook.Default {
  title(): string {
    return "Blockquote";
  }

  tags(): string[] {
    return ["std-blockquote"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Attributed",
        render: () => Blockquote.makeWith({ quote: "A prefix that admits everything classifies nothing.", attribution: "std-component-audit, README", cite: null }),
      },
      {
        title: "Unattributed",
        render: () => Blockquote.makeWith({ quote: "Measure, don't reason.", attribution: null, cite: null }),
      },
    ];
  }
}
