import { Div } from "../component-builtin";
import { Storybook } from "../ui/storybook";
import { Button } from "./button/button";
import { Drawer } from "./drawer";

export class DrawerStoryBook extends Storybook.Default {
  title(): string {
    return "Drawer";
  }

  tags(): string[] {
    return ["std-drawer"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Drawer",
        render: () => {
          return Button.makeWithLight("Toggle Drawer", {
            type: "primary",
            onClick: () => {
              const $content = Div.make();
              $content.textContent = "Drawer Content";
              $content.style.padding = "20px";

              const $drawer = Drawer.instance.get();
              if ($drawer.isRevealed()) {
                $drawer.toggleReveal(false);
              } else {
                $drawer.bind($content, () => {
                  $drawer.toggleReveal(false);
                });
              }
            },
          });
        },
      },
    ];
  }
}
