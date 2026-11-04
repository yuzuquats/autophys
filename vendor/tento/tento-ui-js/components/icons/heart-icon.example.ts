import { Storybook } from "../../ui/storybook";
import { LonaHeartIcon } from "./heart-icon";

export class HeartIconStoryBook extends Storybook.Default {
  title(): string {
    return "Heart Icon";
  }

  tags(): string[] {
    return ["std-heart-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaHeartIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaHeartIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaHeartIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaHeartIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaHeartIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaHeartIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaHeartIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaHeartIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
