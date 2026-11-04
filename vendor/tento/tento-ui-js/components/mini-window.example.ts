import { Center } from "../component-builtin";
import { DomUtils } from "../dom";
import { Storybook } from "../ui/storybook";
import { MiniWindow } from "./mini-window";

export class MiniWindowStoryBook extends Storybook.Default {
  title(): string {
    return "Mini Window";
  }

  tags(): string[] {
    return ["std-mini-window"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          return Storybook.fill(Center.makeWith(
            MiniWindow.makeWith({
              title: "My Window",
            })
              .updateState("docked")
              .assignStyles({
                "--mini-window-width": "200px",
                "--mini-window-height": "200px",
              }),
          ).assignStyles({
            height: "320px",
          }));
        },
      },
      {
        title: "Detached (resizable)",
        render: () => {
          const $w = MiniWindow.makeWith({
            title: "Resizable Window",
          });
          $w.updateState("detached");
          $w.assignStyles({
            "--mini-window-detached-width": "300px",
            "--mini-window-detached-height": "250px",
            "--detached-transform": "translate(40px, 40px)",
          });
          return $w;
        },
      },
    ];
  }
}
