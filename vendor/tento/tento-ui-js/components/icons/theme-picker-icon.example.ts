import { Storybook } from "../../ui/storybook";
import { LonaThemePickerIcon } from "./theme-picker-icon";

export class ThemePickerIconStoryBook extends Storybook.Default {
  title(): string {
    return "Theme Picker Icon";
  }

  tags(): string[] {
    return ["std-theme-picker-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Color (default)",
        render: () => LonaThemePickerIcon.makeWith({ size: 32 }),
      },
      {
        title: "Grayscale",
        render: () =>
          LonaThemePickerIcon.makeWith({ variant: "grayscale", size: 32 }),
      },
      {
        title: "16px",
        render: () => LonaThemePickerIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaThemePickerIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaThemePickerIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaThemePickerIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaThemePickerIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
