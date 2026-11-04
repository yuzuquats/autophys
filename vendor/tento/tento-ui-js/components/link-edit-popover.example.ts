import { Storybook } from "../ui/storybook";
import { LinkEditPopover } from "./link-edit-popover";

export class LinkEditPopoverStoryBook extends Storybook.Default {
  title(): string {
    return "LinkEditPopover";
  }

  tags(): string[] {
    return ["std-link-edit-popover"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () => {
          return LinkEditPopover.make().bind({
            href: "https://ui.lona.so/some/path",
            onOpen: (href) => console.log("Open:", href),
            onSave: (href) => console.log("Save:", href),
            onRemove: () => console.log("Remove"),
          });
        },
      },
      {
        title: "Google Drive Link",
        render: () => {
          return LinkEditPopover.make().bind({
            href: "https://ui.lona.so/document/d/1234567890/edit",
            onOpen: (href) => console.log("Open:", href),
            onSave: (href) => console.log("Save:", href),
            onRemove: () => console.log("Remove"),
          });
        },
      },
      {
        title: "Long URL",
        render: () => {
          return LinkEditPopover.make().bind({
            href: "https://ui.lona.so/very/long/path/to/some/resource?query=param&another=value",
            onOpen: (href) => console.log("Open:", href),
            onSave: (href) => console.log("Save:", href),
            onRemove: () => console.log("Remove"),
          });
        },
      },
    ];
  }
}
