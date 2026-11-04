import { Storybook } from "../../ui/storybook";
import { LonaGlobeIcon } from "./globe-icon";

export class GlobeIconStoryBook extends Storybook.Default {
  title(): string {
    return "Globe Icon";
  }

  tags(): string[] {
    return ["std-globe-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaGlobeIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaGlobeIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaGlobeIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaGlobeIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaGlobeIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaGlobeIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaGlobeIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaGlobeIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
