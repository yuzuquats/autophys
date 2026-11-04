import { Storybook } from "../../ui/storybook";
import { LonaPomodoroIcon } from "./pomodoro-icon";

export class PomodoroIconStoryBook extends Storybook.Default {
  title(): string {
    return "Pomodoro Icon";
  }

  tags(): string[] {
    return ["std-pomodoro-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaPomodoroIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaPomodoroIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaPomodoroIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaPomodoroIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaPomodoroIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaPomodoroIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaPomodoroIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaPomodoroIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
