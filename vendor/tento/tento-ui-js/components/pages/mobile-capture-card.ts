// Side-effect imports: TextInput/PageCard below are referenced only in type
// position, which esbuild erases — these keep the custom elements registered
// in bundles where nothing else imports them (e.g. the signin page).
import "../input/text-input";
import "./page-card";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { TextInput } from "../input/text-input";
import { PageCard } from "./page-card";

@component({ name: "std-mobile-capture-card" })
export class MobileCaptureCard extends LonaWebComponent {
  private $card: PageCard = this.hydrate("card");
  private $email: TextInput = this.hydrate("email");

  private value: string = "";
  private state: MobileCaptureCard.CaptureState = "idle";
  private echoEmail: Option<string> = null;
  private kicker: Option<string> = null;
  private cardTitle: Option<string> = null;
  private message: Option<string> = null;
  private errorText: Option<string> = null;
  private onSubmit: Option<(email: string) => void> = null;
  private onSignInAnyway: Option<() => void> = null;

  constructor() {
    super();
    this.$email.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        this.submit();
      }
    });
  }

  bind(props: MobileCaptureCard.Props): this {
    this.kicker = props.kicker ?? null;
    this.cardTitle = props.title ?? null;
    this.message = props.message ?? null;
    this.state = props.state ?? "idle";
    this.echoEmail = props.email ?? null;
    this.errorText = props.errorText ?? null;
    this.onSubmit = props.onSubmit ?? null;
    this.onSignInAnyway = props.onSignInAnyway ?? null;
    this.render();
    return this;
  }

  private submit(): void {
    if (this.state === "sending" || this.state === "sent") return;
    const email = this.value.trim();
    if (!MobileCaptureCard.looksLikeEmail(email)) {
      // Local pre-check only; the server 422 remains the real source of truth.
      this.state = "error";
      this.errorText = null;
      this.render();
      return;
    }
    this.onSubmit?.(email);
  }

  private render(): void {
    const state = this.state;
    const disabled = state === "sending" || state === "sent";

    // In the confirmation (sent) state the input collapses so the card reads
    // as a receipt rather than an editable form.
    this.$email.style.display = state === "sent" ? "none" : "";
    this.$email.bind({
      label: "Email",
      type: "email",
      value: this.value,
      placeholder: "you@example.com",
      disabled,
      onChange: (value) => {
        this.value = value;
      },
    });

    const footerLink: PageCard.FooterLink = {
      text: "Already have an account? Sign in anyway",
      onClick: () => this.onSignInAnyway?.(),
    };

    // The confirmation (sent) state is a receipt: illustration + congrats
    // title + a caption echoing the destination email (same shape as the
    // onboarding mobile notice). The receipt copy takes over
    // unconditionally, ignoring any kicker/title/message overrides.
    if (state === "sent") {
      this.$card.bind({
        assetSrc: "illustration/stars-splat",
        kicker: null,
        title: "You're in!",
        message: MobileCaptureCard.sentMessage(this.echoEmail),
        primary: null,
        status: null,
        footerLink,
      });
      return;
    }

    this.$card.bind({
      kicker: this.kicker ?? "Mobile app coming soon",
      title: this.cardTitle ?? "Lona is a desktop calendar",
      message: this.message ?? MobileCaptureCard.DEFAULT_MESSAGE,
      primary: {
        text: MobileCaptureCard.buttonText(state, this.echoEmail),
        disabled,
        onClick: () => this.submit(),
      },
      status:
        state === "error"
          ? {
              text:
                this.errorText ?? "That doesn't look like a valid email.",
              variant: "error",
            }
          : null,
      footerLink,
    });
  }

  onRecycle(): void {
    super.onRecycle();
    this.value = "";
    this.state = "idle";
    this.echoEmail = null;
    this.kicker = null;
    this.cardTitle = null;
    this.message = null;
    this.errorText = null;
    this.onSubmit = null;
    this.onSignInAnyway = null;
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

  static $html = html`
    <std-page-card id="card">
      <std-text-input id="email"></std-text-input>
    </std-page-card>
  `;
}

export namespace MobileCaptureCard {
  export type CaptureState = "idle" | "sending" | "sent" | "error";

  export const DEFAULT_MESSAGE =
    "The mobile app is coming soon. Leave your email and we'll send you a " +
    "link for your computer — and you'll be first to know when mobile is " +
    "ready.";

  // Receipt copy for the sent state; echoes the destination email when the
  // server returned one, otherwise a neutral fallback.
  export function sentMessage(email: Option<string>): string {
    if (email != null) {
      return (
        `We sent a link to ${email}. Open it on your computer — ` +
        "we'll email you when the mobile app is ready."
      );
    }
    return (
      "We sent you a link. Open it on your computer — we'll email you " +
      "when the mobile app is ready."
    );
  }

  export function buttonText(
    state: CaptureState,
    email: Option<string>,
  ): string {
    switch (state) {
      case "idle":
        return "Email me the link";
      case "sending":
        return "Sending…";
      case "sent":
        // Unused: the sent state renders as a receipt with no primary button.
        return email != null ? `Sent to ${email} ✓` : "Sent ✓";
      case "error":
        return "Try again";
    }
  }

  // Non-empty and containing an "@" with at least one character on each side.
  export function looksLikeEmail(email: string): boolean {
    const at = email.indexOf("@");
    return at > 0 && at < email.length - 1;
  }

  export type Props = {
    kicker?: Option<string>;
    title?: Option<string>;
    message?: Option<string>;
    state?: Option<CaptureState>;
    email?: Option<string>;
    errorText?: Option<string>;
    onSubmit?: (email: string) => void;
    onSignInAnyway?: () => void;
  };
}
