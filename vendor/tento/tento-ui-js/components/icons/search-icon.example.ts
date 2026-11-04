import { Storybook } from "../../ui/storybook";
import { LonaSearchIcon } from "./search-icon";

/** SearchIcon paints on its host, so keep the slotted card host at tile size. */
function $storybookIcon($icon: LonaSearchIcon): LonaSearchIcon {
  $icon.style.maxWidth = $icon.style.getPropertyValue("--icon-size");
  return $icon;
}

export class SearchIconStoryBook extends Storybook.Default {
  title(): string {
    return "Search Icon";
  }

  tags(): string[] {
    return ["std-search-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => $storybookIcon(LonaSearchIcon.makeWith({ variant: "filled", size: 32 })),
      },
      {
        title: "Grayscale (default)",
        render: () => $storybookIcon(LonaSearchIcon.makeWith({ size: 32 })),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = $storybookIcon(LonaSearchIcon.makeWith({ size: 32 }));
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => $storybookIcon(LonaSearchIcon.makeWith({ size: 16 })),
      },
      {
        title: "20px",
        render: () => $storybookIcon(LonaSearchIcon.makeWith({ size: 20 })),
      },
      {
        title: "24px",
        render: () => $storybookIcon(LonaSearchIcon.makeWith({ size: 24 })),
      },
      {
        title: "32px",
        render: () => $storybookIcon(LonaSearchIcon.makeWith({ size: 32 })),
      },
      {
        title: "48px",
        render: () => $storybookIcon(LonaSearchIcon.makeWith({ size: 48 })),
      },
    ];
  }
}
