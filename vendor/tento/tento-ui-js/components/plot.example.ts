import { Storybook } from "../ui/storybook";
import { Plot } from "./plot";

export class PlotStoryBook extends Storybook.Default {
  title(): string {
    return "Plot";
  }

  tags(): string[] {
    return ["std-plot", "std-plot-tooltip"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Plot",
        render: () => {
          const $c = Plot.make();
          $c.style.height = "200px";
          $c.bind({
            f: {
              r: {
                start: 0,
                end: 10,
              },
              data: (index: number) => {
                return {
                  x: index,
                  y: (index + 1) * 50,
                };
              },
            },
            tooltipsProvider: (idx) => ({
              title: "Plot",
              date: `Index: ${idx}`,
              value: String((idx + 1) * 50),
              change: String(50),
            }),
          });
          return $c;
        },
      },
    ];
  }
}
