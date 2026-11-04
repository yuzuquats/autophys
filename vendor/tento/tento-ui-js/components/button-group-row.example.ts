import { Storybook } from "../ui/storybook";
import { ButtonGroupRow } from "./button-group-row";

type ExampleEnum = "text" | "number";

export class ButtonGroupRowStoryBook extends Storybook.Default {
  title(): string {
    return "Button Group";
  }

  tags(): string[] {
    return ["std-button-group-row"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Button Group",
        render: () => {
          // Create without generic parameter first, then cast
          const $c = ButtonGroupRow.make();
          const buttonGroup = $c as ButtonGroupRow<ExampleEnum>;

          // NOTE: callers *should* tell this component how wide it should be
          buttonGroup.style.width = "200px";
          buttonGroup.bind("text", [
            {
              label: "Number",
              identifier: "number",
            },
            {
              label: "Text",
              identifier: "text",
            },
          ]);
          return buttonGroup;
        },
      },
    ];
  }
}
