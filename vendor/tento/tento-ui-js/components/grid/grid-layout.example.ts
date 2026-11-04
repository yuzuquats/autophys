import "./grid-layout";

import { GridLayout } from "./grid-layout";
import { Storybook } from "../../ui/storybook";
import { Center } from "../../component-builtin";

export class GridLayoutStoryBook extends Storybook.Default {
  title(): string {
    return "Grid Layout";
  }

  tags(): string[] {
    return ["std-grid-layout"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic Grid",
        render: () => {
          const $grid = GridLayout.make();
          $grid.bind({
            blockSpacingPx: 4,
            inlineSpacingPx: 4,
            minWidthPx: 60,
          });
          $grid.style.width = "100%";

          for (let i = 0; i < 20; i++) {
            const $card = Center.make().assignStyles({
              background: "var(--blue-dimmed)",
              borderRadius: "8px",
              height: `${100 + Math.random() * 100}px`,
              color: "var(--text-sec)",
            });
            $card.textContent = String(i);
            $grid.appendChild($card);
          }

          return $grid;
        },
      },
    ];
  }
}
