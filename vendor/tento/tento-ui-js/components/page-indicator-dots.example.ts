import { Storybook } from "../ui/storybook";
import { PageIndiciatorDots } from "./page-indicator-dots";

export class PageIndicatorDotsStoryBook extends Storybook.Default {
  title(): string {
    return "Page Indicator Dots";
  }

  tags(): string[] {
    return ["std-page-indicator-dots"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Page Indicator Dots",
        render: () => {
          const $c = PageIndiciatorDots.make();
          $c.bind(3, 5);
          $c.assignStyles({
            "--size": "8px",
          });
          return $c;
        },
      },
      {
        title: "Custom Colors",
        render: () => {
          const $c = PageIndiciatorDots.make();
          $c.bind(2, 5, (index) => {
            const colors = [
              "var(--blue)",
              "var(--green)",
              "var(--orange)",
              "var(--purple)",
              "var(--red)",
            ];
            return colors[index];
          });
          $c.assignStyles({
            "--size": "8px",
          });
          return $c;
        },
      },
    ];
  }
}
