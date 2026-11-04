import { Storybook } from "../../ui/storybook";
import { LonaTildeIcon } from "./tilde-icon";

export class TildeIconStoryBook extends Storybook.Default {
  title(): string {
    return "Tilde Icon";
  }

  tags(): string[] {
    return ["std-tilde-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaTildeIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaTildeIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaTildeIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaTildeIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaTildeIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaTildeIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaTildeIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaTildeIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
