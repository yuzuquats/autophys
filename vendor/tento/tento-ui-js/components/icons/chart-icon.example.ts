import { Storybook } from "../../ui/storybook";
import { LonaChartIcon } from "./chart-icon";

export class ChartIconStoryBook extends Storybook.Default {
  title(): string {
    return "Chart Icon";
  }

  tags(): string[] {
    return ["std-chart-icon"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Filled",
        render: () => LonaChartIcon.makeWith({ variant: "filled", size: 32 }),
      },
      {
        title: "Grayscale (default)",
        render: () => LonaChartIcon.makeWith({ size: 32 }),
      },
      {
        title: "Hover",
        render: () => {
          const $icon = LonaChartIcon.makeWith({ size: 32 });
          $icon.toggleAttribute("hover", true);
          return $icon;
        },
      },
      {
        title: "16px",
        render: () => LonaChartIcon.makeWith({ size: 16 }),
      },
      {
        title: "20px",
        render: () => LonaChartIcon.makeWith({ size: 20 }),
      },
      {
        title: "24px",
        render: () => LonaChartIcon.makeWith({ size: 24 }),
      },
      {
        title: "32px",
        render: () => LonaChartIcon.makeWith({ size: 32 }),
      },
      {
        title: "48px",
        render: () => LonaChartIcon.makeWith({ size: 48 }),
      },
    ];
  }
}
