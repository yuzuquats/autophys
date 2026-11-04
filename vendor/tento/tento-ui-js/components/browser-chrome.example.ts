import "./browser-chrome";

import { Center } from "../component-builtin";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { BrowserChrome } from "./browser-chrome";

export class BrowserChromeStoryBook extends Storybook.Default {
  title(): string {
    return "Browser Chrome";
  }

  tags(): string[] {
    return ["std-browser-chrome"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "With content",
        render: () => {
          const $bc = BrowserChrome.makeWith();
          const $content = Center.make();
          $content.appendChild(Typography.h4("Hello World"));
          $bc.appendChild(
            $content.assignStyles({
              height: "200px",
            }),
          );
          return $bc;
        },
      },
      {
        title: "Empty",
        render: () => {
          const $bc = BrowserChrome.makeWith();
          return $bc;
        },
      },
    ];
  }
}
