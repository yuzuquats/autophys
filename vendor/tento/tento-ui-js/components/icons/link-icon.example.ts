import { Storybook } from "../../ui/storybook";
import { LonaLinkIcon } from "./link-icon";

export class LinkIconStoryBook extends Storybook.Default {
  title(): string {
    return "Link Icon";
  }

  tags(): string[] {
    return ["std-link-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaLinkIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaLinkIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaLinkIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaLinkIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaLinkIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaLinkIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaLinkIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaLinkIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
