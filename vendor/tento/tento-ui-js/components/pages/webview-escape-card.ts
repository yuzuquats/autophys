import "./page-card";

import { Tracing } from "@tento-core/tracing";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { PageCard } from "./page-card";

@component({ name: "std-webview-escape-card" })
export class WebviewEscapeCard extends LonaWebComponent {
  private $card: PageCard = this.hydrate("card");
  private $iosSteps: HTMLElement = this.$("ios-steps");

  private lastProps: Option<WebviewEscapeCard.Props> = null;
  private copyLabel: string = "Copy link";
  private copiedTimer: Option<number> = null;

  bind(props: WebviewEscapeCard.Props): this {
    this.lastProps = props;
    this.copyLabel = "Copy link";
    this.render();
    return this;
  }

  private render(): void {
    const props = this.lastProps;
    if (props == null) return;

    const isAndroid = props.platform === "android";
    this.$iosSteps.style.display = isAndroid ? "none" : "";

    const copyAction: PageCard.Action = {
      text: this.copyLabel,
      onClick: () => void this.copyLink(),
    };

    this.$card.bind({
      title: props.title ?? "Open Lona in your browser",
      message:
        props.message ??
        "Google sign-in can't run inside this app's built-in browser.",
      primary: isAndroid
        ? { text: "Open in browser", onClick: () => props.onOpenBrowser?.() }
        : copyAction,
      secondary: isAndroid ? copyAction : null,
      footer: props.url,
      footerLink: {
        text: "Try signing in here anyway",
        onClick: () => props.onTryAnyway?.(),
      },
    });
  }

  private async copyLink(): Promise<void> {
    const props = this.lastProps;
    const url = props?.url ?? "";
    try {
      await navigator.clipboard.writeText(url);
      this.copyLabel = "Copied ✓";
      props?.onCopied?.();
    } catch (error) {
      Tracing.warn("ui")("webview-escape copy failed", {
        error: String(error),
      });
      this.copyLabel = "Couldn't copy — long-press the link";
    }
    this.render();
    if (this.copiedTimer != null) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => this.resetCopyButton(), 2000);
  }

  private resetCopyButton(): void {
    this.copyLabel = "Copy link";
    this.render();
  }

  private clearCopiedTimer(): void {
    if (this.copiedTimer != null) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = null;
    }
  }

  onRecycle(): void {
    super.onRecycle();
    this.clearCopiedTimer();
    this.copyLabel = "Copy link";
    this.lastProps = null;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearCopiedTimer();
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #card {
        width: 100%;
      }

      /* the chip is a layout container (clean flex box for the template's
         action-block gap); the inner p carries the typography */
      #ios-steps {
        background: var(--bg-hover);
        border-radius: 10px;
        padding: 12px 16px;
      }

      #ios-steps p {
        --font-size: var(--p-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        text-align: center;
        color: var(--text-pri);
      }
    `,
  ];

  static $html = html`
    <std-page-card id="card">
      <div id="ios-steps">
        <p>Tap ··· in the top right, then "Open in external browser"</p>
      </div>
    </std-page-card>
  `;
}

export namespace WebviewEscapeCard {
  export type Platform = "android" | "ios";

  export type Props = {
    platform: Platform;
    url: string;
    title?: Option<string>;
    message?: Option<string>;
    onOpenBrowser?: () => void;
    onCopied?: () => void;
    onTryAnyway?: () => void;
  };
}
