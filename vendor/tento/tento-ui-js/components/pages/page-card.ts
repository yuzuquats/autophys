import "../presentation/presentation-asset";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Button } from "../button/button";
import { PresentationAsset } from "../presentation/presentation-asset";

@component({ name: "std-page-card" })
export class PageCard extends LonaWebComponent {
  private $asset: Option<PresentationAsset> = null;
  private $text: HTMLElement = this.$("text");
  private $kicker: HTMLElement = this.$("kicker");
  private $title: HTMLElement = this.$("title");
  private $message: HTMLElement = this.$("message");
  private $primary: Button = this.hydrate("primary");
  private $secondary: Button = this.hydrate("secondary");
  private $status: HTMLElement = this.$("status");
  private $footer: HTMLElement = this.$("footer");
  private $footerLink: HTMLElement = this.$("footer-link");

  private primaryAction: Option<PageCard.Action> = null;
  private secondaryAction: Option<PageCard.Action> = null;
  private footerLink: Option<PageCard.FooterLink> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$primary, {
      onClick: () => this.primaryAction?.onClick?.(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$secondary, {
      onClick: () => this.secondaryAction?.onClick?.(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$footerLink, {
      onClick: () => this.footerLink?.onClick(),
    });
  }

  bind(props: PageCard.Props): this {
    this.bindAsset(props.assetSrc);
    this.bindText(this.$kicker, props.kicker);
    this.bindText(this.$title, props.title);
    this.bindText(this.$message, props.message);
    this.$text.toggleAttribute("hidden", !this.hasText(props));
    this.bindAction(this.$primary, props.primary, "primary");
    this.bindAction(this.$secondary, props.secondary, "secondary");
    this.primaryAction = props.primary ?? null;
    this.secondaryAction = props.secondary ?? null;
    this.bindStatus(props.status);
    this.bindText(this.$footer, props.footer);
    this.bindFooterLink(props.footerLink);
    return this;
  }

  private hasText(props: PageCard.Props): boolean {
    return [props.kicker, props.title, props.message].some(
      (value) => value != null && value.trim() !== "",
    );
  }

  // The illustration is optional (`assetSrc`), but std-presentation-asset
  // reports a missing `src` as an error the moment it is upgraded — and
  // `hydrate()` upgrades eagerly, in the constructor. A src-less asset in the
  // static template therefore made every card without an illustration (the
  // signin mobile-capture card among them) log "presentation asset src
  // required" just by existing. So the element is not in the template: it is
  // created on first use, once a src is actually known.
  private bindAsset(assetSrc: Option<string>): void {
    const asset = this.$asset;
    // A blank src means "no illustration", not an error — PresentationAsset
    // throws on an empty src, so it must never reach bind().
    const src = assetSrc?.trim() ?? "";
    if (!src) {
      if (asset != null) asset.style.display = "none";
      return;
    }
    const props: PresentationAsset.Props = {
      src,
      alt: null,
      fit: null,
      decorative: true,
      registry: null,
    };
    if (asset != null) {
      asset.bind(props);
      asset.style.display = "";
      return;
    }
    const created = PresentationAsset.makeWith(props);
    created.id = "asset";
    const $root = this.$("root");
    $root.insertBefore(created, $root.firstChild);
    this.$asset = created;
  }

  private bindText(el: HTMLElement, value: Option<string>): void {
    if (value != null) {
      el.textContent = value;
      el.style.display = "";
    } else {
      el.textContent = "";
      el.style.display = "none";
    }
  }

  private bindAction(
    $button: Button,
    action: Option<PageCard.Action>,
    variant: "primary" | "secondary",
  ): void {
    if (action != null) {
      $button.textContent = action.text;
      $button.toggleAttribute(variant, true);
      $button.toggleAttribute("disabled", action.disabled === true);
      $button.style.display = "";
    } else {
      $button.style.display = "none";
    }
  }

  private bindStatus(status: Option<PageCard.Status>): void {
    this.$status.classList.remove("error", "success");
    if (status != null) {
      this.$status.textContent = status.text;
      this.$status.style.display = "";
      if (status.variant === "error") this.$status.classList.add("error");
      if (status.variant === "success") this.$status.classList.add("success");
    } else {
      this.$status.textContent = "";
      this.$status.style.display = "none";
    }
  }

  private bindFooterLink(footerLink: Option<PageCard.FooterLink>): void {
    this.footerLink = footerLink ?? null;
    if (footerLink != null) {
      this.$footerLink.textContent = footerLink.text;
      this.$footerLink.style.display = "";
    } else {
      this.$footerLink.textContent = "";
      this.$footerLink.style.display = "none";
    }
  }

  onRecycle(): void {
    super.onRecycle();
    this.primaryAction = null;
    this.secondaryAction = null;
    this.footerLink = null;
  }

  static $styles = [
    Button.$style,
    css`
      :host {
        display: block;
        /* one content frame: every zone (text, inputs, buttons) fills the
           padding-defined column — 376 - 2×28 = 320 at defaults */
        max-width: var(--page-card-max-width, 376px);
        margin-inline: auto;
      }

      #root {
        background: var(--page-card-bg, var(--bg));
        border-radius: var(--page-card-radius, 16px);
        padding: var(--page-card-padding, 40px 28px);
        box-shadow: var(--page-card-shadow, 0 4px 24px rgba(0, 0, 0, 0.1));
        align-items: center;
        gap: 0px;
      }

      /* center our own text zones only — slotted content keeps its alignment */
      #kicker,
      #title,
      #message,
      #status,
      #footer,
      #footer-link {
        text-align: center;
      }

      /* The asset fills the same content frame as the text and buttons and
         keeps itself square by scaling height with the frame width. A card
         can pin a fixed size via --page-card-asset-size. Card assets are
         contain-fit illustrations that never overflow, so unclip the asset
         stage to let tile drop-shadows breathe. */
      #asset {
        width: var(--page-card-asset-size, 100%);
        aspect-ratio: 1 / 1;
        margin-bottom: 32px;
        --presentation-asset-overflow: visible;
      }

      /* The text block owns the gap to the actions below it — the zones
         inside only space each other, so the text→CTA distance holds no
         matter which of kicker/title/message a card binds. */
      #text {
        width: 100%;
        margin-bottom: 36px;
      }

      #text[hidden] {
        display: none;
      }

      #kicker {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 10px;
        color: var(--text-ter);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      #title {
        --font-size: var(--h2-size);
        --margin-top: 0px;
        --margin-bottom: 18px;
      }

      #message {
        --font-size: var(--p-size);
        --line-height-ratio: 1.4;
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-sec);
      }

      /* The action block spaces its mixed content (slotted inputs/chips +
         buttons) with flex gap — box-to-box, no typography-margin math.
         The <slot> is display:contents, so slotted nodes are the flex items
         and stretch to the frame. */
      #actions {
        width: 100%;
        gap: 12px;
        align-items: stretch;
      }

      ::slotted(*) {
        box-sizing: border-box;
      }

      #primary,
      #secondary {
        height: 40px;
      }

      #status {
        --font-size: var(--small-size);
        --margin-top: 18px;
        --margin-bottom: 0px;
        color: var(--text-sec);
      }

      #status.error {
        color: var(--red);
      }

      #status.success {
        color: var(--green);
      }

      #footer {
        --font-size: var(--small-size);
        --margin-top: 18px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }

      #footer-link {
        --font-size: var(--small-size);
        --margin-top: 14px;
        --margin-bottom: 0px;
        color: var(--text-ter);
        text-decoration: underline;
        cursor: pointer;
      }
    `,
  ];

  static $html = html`
    <std-col id="root">
      <std-col id="text" hidden>
        <p id="kicker"></p>
        <h1 id="title"></h1>
        <p id="message"></p>
      </std-col>
      <std-col id="actions">
        <slot></slot>
        <std-button id="primary"></std-button>
        <std-button id="secondary"></std-button>
      </std-col>
      <p id="status"></p>
      <p id="footer"></p>
      <p id="footer-link"></p>
    </std-col>
  `;
}

export namespace PageCard {
  export type StatusVariant = "default" | "error" | "success";

  export type Action = {
    text: string;
    onClick?: Option<() => void>;
    disabled?: Option<boolean>;
  };

  export type Status = {
    text: string;
    variant?: Option<StatusVariant>;
  };

  export type FooterLink = {
    text: string;
    onClick: () => void;
  };

  export type Props = {
    assetSrc?: Option<string>;
    kicker?: Option<string>;
    title?: Option<string>;
    message?: Option<string>;
    primary?: Option<Action>;
    secondary?: Option<Action>;
    status?: Option<Status>;
    footer?: Option<string>;
    footerLink?: Option<FooterLink>;
  };
}
