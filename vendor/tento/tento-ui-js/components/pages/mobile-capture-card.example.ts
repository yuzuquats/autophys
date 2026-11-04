import { Storybook } from "@tento-ui/ui/storybook";
import { BrowserChrome } from "../browser-chrome";
import { MobileCaptureCard } from "./mobile-capture-card";

function $onPhone($card: MobileCaptureCard): HTMLElement {
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

export class MobileCaptureCardStoryBook extends Storybook.Default {
  title(): string {
    return "Mobile Capture Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Interactive (idle → sending → sent)",
        render: () => {
          const $card = MobileCaptureCard.make() as MobileCaptureCard;
          const bindWith = (
            state: MobileCaptureCard.CaptureState,
            email: Option<string>,
          ) =>
            $card.bind({
              state,
              email,
              onSubmit: (submitted) => {
                bindWith("sending", submitted);
                setTimeout(() => bindWith("sent", submitted), 900);
              },
              onSignInAnyway: () => {},
            });
          bindWith("idle", null);
          return $onPhone($card);
        },
      },
      {
        title: "Error",
        render: () =>
          $onPhone(
            (MobileCaptureCard.make() as MobileCaptureCard).bind({
              state: "error",
              errorText: "That doesn't look like a valid email.",
            }),
          ),
      },
      {
        title: "Sent",
        render: () =>
          $onPhone(
            (MobileCaptureCard.make() as MobileCaptureCard).bind({
              state: "sent",
              email: "kiana@example.com",
            }),
          ),
      },
    ];
  }
}
