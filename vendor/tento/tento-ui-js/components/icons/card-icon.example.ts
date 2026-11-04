import { Storybook } from "../../ui/storybook";
import { LonaCardIcon } from "./card-icon";

export class CardIconStoryBook extends Storybook.Default {
  title(): string {
    return "Calendar Icon";
  }

  tags(): string[] {
    return ["std-calendar-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaCardIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaCardIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaCardIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaCardIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaCardIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaCardIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaCardIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaCardIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
