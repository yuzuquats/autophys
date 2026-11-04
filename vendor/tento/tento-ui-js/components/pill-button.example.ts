import { Storybook } from "../ui/storybook";
import { PillButton } from "./pill-button";

export class PillButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Pill Button";
  }

  tags(): string[] {
    return ["std-pill-button"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Pill Button",
        render: () => {
          const $c = PillButton.make();
          $c.bind("#work", {
            background: "var(--red)",
          });
          return $c;
        },
      },
    ];
  }
}
