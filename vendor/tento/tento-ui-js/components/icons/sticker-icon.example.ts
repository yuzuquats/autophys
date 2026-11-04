import { Storybook } from "../../ui/storybook";
import { LonaStickerIcon } from "./sticker-icon";

export class StickerIconStoryBook extends Storybook.Default {
  title(): string {
    return "Sticker Icon";
  }

  tags(): string[] {
    return ["std-sticker-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaStickerIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaStickerIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaStickerIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaStickerIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaStickerIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaStickerIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaStickerIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaStickerIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
