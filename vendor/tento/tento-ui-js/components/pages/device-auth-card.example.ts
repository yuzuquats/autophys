import { Storybook } from "@tento-ui/ui/storybook";
import { BrowserChrome } from "../browser-chrome";
import { DeviceAuthCard } from "./device-auth-card";
import { SimpleAuthPage } from "./simple-auth-page";

function makePage(card: DeviceAuthCard): HTMLElement {
  const $page = SimpleAuthPage.make();
  $page.style.height = "640px";
  card.assignStyles({
    maxWidth: "520px",
  });
  $page.appendChild(card);
  return BrowserChrome.makeExample($page, "dev.lona.so:8443/auth/device", 900);
}

export class DeviceAuthCardStoryBook extends Storybook.Default {
  title(): string {
    return "Device Auth Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Empty",
        render: () => {
          const $card = DeviceAuthCard.make().bind({
            initialCode: "",
            onApprove: () => {},
          });
          return makePage($card);
        },
      },
      {
        title: "Prefilled Code",
        render: () => {
          const $card = DeviceAuthCard.make().bind({
            initialCode: "ABCD-EFGH",
            statusMessage:
              "Code detected from URL. Click Approve Device to continue.",
            onApprove: () => {},
          });
          return makePage($card);
        },
      },
      {
        title: "Busy",
        render: () => {
          const $card = DeviceAuthCard.make().bind({
            initialCode: "ABCD-EFGH",
            isBusy: true,
            statusMessage: "Approving device...",
            onApprove: () => {},
          });
          return makePage($card);
        },
      },
      {
        title: "Error",
        render: () => {
          const $card = DeviceAuthCard.make().bind({
            initialCode: "ZZZZ-0000",
            statusMessage: "Could not approve device: User code has expired",
            statusVariant: "error",
            onApprove: () => {},
          });
          return makePage($card);
        },
      },
      {
        title: "Success",
        render: () => {
          const $card = DeviceAuthCard.make().bind({
            initialCode: "QWER-1234",
            isApproved: true,
            statusMessage: "Device approved.",
            statusVariant: "success",
            onApprove: () => {},
          });
          return makePage($card);
        },
      },
    ];
  }
}
