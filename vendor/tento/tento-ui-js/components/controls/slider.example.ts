import "./slider.test";

import { range } from "@tento-chrono";
import { $jsx } from "../../ui/jsx";
import { Storybook } from "../../ui/storybook";
import { Slider } from "./slider";

export class SliderStoryBook extends Storybook.Default {
  title(): string {
    return "Slider";
  }

  tags(): string[] {
    return ["std-apple-slider"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $slider = Slider.Default.make();
          // NOTE: callers *should* *really* tell this component how wide it should be
          $slider.setBounds(
            {
              start: 100,
              end: 400,
            },
            100,
          );
          return Storybook.fill($slider, "320px");
        },
      },
    ];
  }
}

export class ThickSliderStoryBook extends Storybook.Default {
  title(): string {
    return "Slider";
  }

  tags(): string[] {
    return ["std-thick-slider"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $slider = Slider.Thick.make();
          $slider.appendChild(
            $jsx(
              "p",
              {
                className: "h6",
                style: {
                  color: "var(--text-ter)",
                },
              },
              "Label",
            ),
          );
          $slider.setSnap([0, 50, 100, 150, 200, 250, 300]);
          return Storybook.fill($slider, "320px");
        },
      },
      {
        render: () => {
          const $slider = Slider.Thick.make();
          $slider.bind({
            bounds: { start: 0, end: 24 },
            value: 8,
            snap: [...range(25)],
            // renderLastSnap: true,
            renderSnaps: false,
          });
          return Storybook.fill($slider, "320px");
        },
      },
    ];
  }
}
