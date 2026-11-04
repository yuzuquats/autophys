import "./page-card";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { PageCard } from "./page-card";

@component({ name: "std-mobile-bridge-card" })
export class MobileBridgeCard extends LonaWebComponent {
  private $card: PageCard = this.hydrate("card");

  bind(props: MobileBridgeCard.Props): this {
    const emailState = props.emailState ?? "idle";
    const buttonText = MobileBridgeCard.buttonText(emailState, props.email);

    this.$card.bind({
      assetSrc: props.assetSrc ?? "illustration/stars",
      kicker: props.kicker ?? "Mobile access",
      title: props.title ?? "You're in — your 30-day trial has started.",
      message:
        props.message ??
        "Lona is a desktop calendar today. Your Google Calendar is already " +
          "connected and syncing — open Lona on your computer and your week " +
          "will be waiting. A mobile app is coming; we'll email you when it ships.",
      primary: {
        text: buttonText,
        disabled: emailState !== "idle",
        onClick: () => props.onEmailLink?.(),
      },
      footer:
        props.urlLine ??
        "or open lona.so on your computer and sign in with the same Google account",
    });

    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #card {
        width: 100%;
      }
    `,
  ];

  static $html = html`<std-page-card id="card"></std-page-card>`;
}

export namespace MobileBridgeCard {
  export type EmailState = "idle" | "sending" | "sent";

  export function buttonText(
    state: EmailState,
    email: Option<string>,
  ): string {
    switch (state) {
      case "idle":
        return "Email me the link";
      case "sending":
        return "Sending…";
      case "sent":
        return email != null ? `Sent to ${email} ✓` : "Sent ✓";
    }
  }

  export type Props = {
    kicker?: Option<string>;
    title?: Option<string>;
    message?: Option<string>;
    urlLine?: Option<string>;
    assetSrc?: Option<string>;
    email?: Option<string>;
    emailState?: Option<EmailState>;
    onEmailLink?: () => void;
  };
}
