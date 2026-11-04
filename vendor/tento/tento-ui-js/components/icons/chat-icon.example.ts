import { Storybook } from "../../ui/storybook";
import { LonaChatIcon } from "./chat-icon";

export class ChatIconStoryBook extends Storybook.Default {
  title(): string {
    return "Chat Icon";
  }

  tags(): string[] {
    return ["std-chat-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaChatIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaChatIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaChatIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaChatIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaChatIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaChatIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaChatIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaChatIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
