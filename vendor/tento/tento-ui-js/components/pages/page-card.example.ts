import { Storybook } from "@tento-ui/ui/storybook";
import { BrowserChrome } from "../browser-chrome";
import { PageCard } from "./page-card";

function $onPhone($card: PageCard): HTMLElement {
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
  return BrowserChrome.makeExample($page, "lona.so/page", 430);
}

export class PageCardStoryBook extends Storybook.Default {
  title(): string {
    return "Page Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "All zones",
        render: () =>
          $onPhone(
            (PageCard.make() as PageCard).bind({
              assetSrc: "illustration/stars",
              kicker: "Mobile access",
              title: "You're all set",
              message:
                "Everything is connected and syncing. Here's a card with " +
                "every zone populated so you can see the full template.",
              primary: { text: "Continue", onClick: () => {} },
              secondary: { text: "Not now", onClick: () => {} },
              status: { text: "Saved successfully ✓", variant: "success" },
              footer: "or open lona.so on your computer to keep going",
              footerLink: { text: "Need help?", onClick: () => {} },
            }),
          ),
      },
      {
        title: "Minimal",
        render: () =>
          $onPhone(
            (PageCard.make() as PageCard).bind({
              title: "Sign in to continue",
              message: "Use the same account you signed up with.",
              primary: { text: "Sign in", onClick: () => {} },
            }),
          ),
      },
      {
        title: "Status variants",
        render: () =>
          $onPhone(
            (PageCard.make() as PageCard).bind({
              title: "Something went wrong",
              message: "We couldn't verify that code. Try again.",
              primary: { text: "Retry", onClick: () => {} },
              status: {
                text: "Code has expired",
                variant: "error",
              },
            }),
          ),
      },
    ];
  }
}
