import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Toast } from "../toast/toast";
import { SafariBlock } from "./safari-block";
import { Session } from "../../session";

export class SafariBlockStoryBook extends Storybook.Default {
  title(): string {
    return "Safari Block";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Show Safari Block",
        render: () => {
          return Button.makeWith("Show Safari Block", {
            type: "primary",
            onClick: () => {
              const $block = SafariBlock.showIfSafari();
              if (!$block) {
                Toast.info(`Not Safari (isSafari=${Session.isSafari})`);
              }
            },
          });
        },
      },
      {
        title: "Force Show (bypass check)",
        render: () => {
          return Button.makeWith("Force Show", {
            type: "secondary",
            onClick: () => {
              SafariBlock.showIfSafari(true);
            },
          });
        },
      },
    ];
  }
}
