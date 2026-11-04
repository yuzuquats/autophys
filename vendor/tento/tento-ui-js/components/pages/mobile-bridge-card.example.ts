import { Storybook } from "@tento-ui/ui/storybook";
import { BrowserChrome } from "../browser-chrome";
import { MobileBridgeCard } from "./mobile-bridge-card";

function $onPhone($card: MobileBridgeCard): HTMLElement {
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
  return BrowserChrome.makeExample($page, "calendar.lona.so/onboarding", 430);
}

export class MobileBridgeCardStoryBook extends Storybook.Default {
  title(): string {
    return "Mobile Bridge Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Interactive (idle → sending → sent)",
        render: () => {
          const $card = MobileBridgeCard.make() as MobileBridgeCard;
          const bindWith = (state: MobileBridgeCard.EmailState) =>
            $card.bind({
              email: "kiana@example.com",
              emailState: state,
              onEmailLink: () => {
                bindWith("sending");
                setTimeout(() => bindWith("sent"), 900);
              },
            });
          bindWith("idle");
          return $onPhone($card);
        },
      },
      {
        title: "Sent",
        render: () =>
          $onPhone(
            (MobileBridgeCard.make() as MobileBridgeCard).bind({
              email: "kiana@example.com",
              emailState: "sent",
            }),
          ),
      },
    ];
  }
}
