import { Storybook } from "../../ui/storybook";
import { SheetsIcon } from "./sheets-icon";

export class SheetsIconStoryBook extends Storybook.Default {
  title(): string {
    return "Sheets Icon";
  }

  tags(): string[] {
    return ["std-sheets-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled (default)",
        render: () => SheetsIcon.makeWith({ size: 32 }),
      },
      {
        title: "Grayscale",
        render: () => SheetsIcon.makeWith({ variant: "grayscale", size: 32 }),
      },
      {
        title: "Grayscale · Hover",
        render: () => {
          const $icon = SheetsIcon.makeWith({ variant: "grayscale", size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => SheetsIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => SheetsIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => SheetsIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => SheetsIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => SheetsIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
