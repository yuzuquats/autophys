import { DragDrop } from "../../drag-drop";
import { Storybook } from "../../ui/storybook";
import { SidebarStickerSection } from "./sidebar-sticker-section";

export class SidebarStickerSectionStoryBook extends Storybook.Default {
  title(): string {
    return "Sidebar Sticker Section";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Pack Paging",
        render: () => SidebarStickerSectionStoryBook.$section(),
      },
    ];
  }
}

export namespace SidebarStickerSectionStoryBook {
  export function $section(): SidebarStickerSection {
    const $section = SidebarStickerSection.make().bind({
      controller: new DragDrop.Controller(),
    });
    $section.assignStyles({
      width: "360px",
      height: "520px",
    });
    $section.toggleExpanded(true);
    return $section;
  }
}
