import { Storybook } from "@tento-ui/ui/storybook";
import { BrowserChrome } from "../browser-chrome";
import { WebviewEscapeCard } from "./webview-escape-card";

const ESCAPE_URL =
  "https://lona.so/signin?utm_medium=paid&utm_source=ig&fbclid=IwZXh0Example";

function $onPhone($card: WebviewEscapeCard): HTMLElement {
  const $page = document.createElement("std-col");
  $page.assignStyles({
    alignItems: "center",
    justifyContent: "center",
    minHeight: "560px",
    padding: "24px",
    boxSizing: "border-box",
    background: "var(--bg-hover)",
  });
  $card.style.maxWidth = "400px";
  $page.appendChild($card);
  return BrowserChrome.makeExample($page, "lona.so/signin", 430);
}

export class WebviewEscapeCardStoryBook extends Storybook.Default {
  title(): string {
    return "Webview Escape Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "iOS (Instagram in-app browser)",
        render: () =>
          $onPhone(
            (WebviewEscapeCard.make() as WebviewEscapeCard).bind({
              platform: "ios",
              url: ESCAPE_URL,
            }),
          ),
      },
      {
        title: "Android (intent escape)",
        render: () =>
          $onPhone(
            (WebviewEscapeCard.make() as WebviewEscapeCard).bind({
              platform: "android",
              url: ESCAPE_URL,
              onOpenBrowser: () => window.open(ESCAPE_URL, "_blank"),
            }),
          ),
      },
    ];
  }
}
