import { Storybook } from "../../ui/storybook";
import { SidebarExpandButton } from "./sidebar-expand-button";

export class SidebarExpandButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Sidebar Expand Button";
  }

  tags(): string[] {
    return ["std-sidebar-expand-button"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Sidebar Expand Button",
        render: () => {
          const $c = SidebarExpandButton.make();
          $c.style.setProperty("--icon-primary-color", "#333");
          return $c;
        },
      },
    ];
  }
}
