import { Storybook } from "../../ui/storybook";
import { TasksIcon } from "./tasks-icon";

export class TasksIconStoryBook extends Storybook.Default {
  title(): string {
    return "Tasks Icon";
  }

  tags(): string[] {
    return ["std-tasks-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled (default)",
        render: () => TasksIcon.makeWith({ size: 32 }),
      },
      {
        title: "Grayscale",
        render: () => TasksIcon.makeWith({ variant: "grayscale", size: 32 }),
      },
      {
        title: "Grayscale · Hover",
        render: () => {
          const $icon = TasksIcon.makeWith({ variant: "grayscale", size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => TasksIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => TasksIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => TasksIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => TasksIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => TasksIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
