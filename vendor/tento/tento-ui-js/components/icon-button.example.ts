import { PlusIcon } from "../ui/icons";
import { Storybook } from "../ui/storybook";
import { IconButton } from "./icon-button";

export class IconButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Icon Button";
  }

  tags(): string[] {
    return ["std-icon-button"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Icon Button",
        render: () => IconButton.make().bindIcon(PlusIcon, { squarish: true }),
      },
    ];
  }
}
