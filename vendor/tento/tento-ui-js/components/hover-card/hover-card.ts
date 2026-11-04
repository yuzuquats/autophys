import "../popover/popover";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Position } from "../../anchor-positioning-utils";
import { Anchor, type AnchorInstance } from "../anchor";
import { Popover } from "../popover/popover";

// A popover that opens on hover and stays while you read it. It attaches to
// its parent the way the tooltip does — hover and focus, with an open delay
// and a close delay — and reveals a `std-popover` with no role through
// `Anchor.reveal`, NOT through `Popover.show()`: a hover card must never
// steal focus from the thing being hovered. The card stays open while the
// pointer is inside it, so a reader can reach a link in it; Escape closes.
@component({ name: "std-hover-card" })
export class HoverCard extends LonaWebComponent {
  private props: Option<HoverCard.Props>;
  private $trigger: Option<HTMLElement>;
  private openTimer: Option<number>;
  private closeTimer: Option<number>;
  private instance: Option<AnchorInstance>;
  private $card: Option<Popover>;

  bind(props: HoverCard.Props): this {
    this.props = props;
    return this;
  }

  static makeWith(props: HoverCard.Props): HoverCard {
    return HoverCard.make().bind(props);
  }

  connectedCallback(): void {
    super.connectedCallback();
    const $t = this.parentElement;
    if ($t == null) return;
    this.$trigger = $t;
    $t.addEventListener("pointerenter", this.onEnter);
    $t.addEventListener("pointerleave", this.onLeave);
    $t.addEventListener("focusin", this.onEnter);
    $t.addEventListener("focusout", this.onLeave);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.close();
    const $t = this.$trigger;
    if ($t != null) {
      $t.removeEventListener("pointerenter", this.onEnter);
      $t.removeEventListener("pointerleave", this.onLeave);
      $t.removeEventListener("focusin", this.onEnter);
      $t.removeEventListener("focusout", this.onLeave);
    }
    this.$trigger = null;
  }

  onRecycle(): void {
    super.onRecycle();
    this.close();
    this.props = null;
  }

  private onEnter = (): void => {
    this.clearTimers();
    if (this.instance != null) return;
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      this.open();
    }, this.props?.openDelayMs ?? 300);
  };

  private onLeave = (event: Event): void => {
    if (event.type === "pointerleave" && this.hasFocus()) return;
    this.clearTimers();
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (this.hasFocus()) return;
      this.close();
    }, this.props?.closeDelayMs ?? 200);
  };

  private hasFocus(): boolean {
    return this.$trigger?.matches(":focus-within") === true || this.$card?.matches(":focus-within") === true;
  }

  private releaseCard(): void {
    const $card = this.$card;
    if ($card == null) return;
    $card.removeEventListener("pointerenter", this.onEnter);
    $card.removeEventListener("pointerleave", this.onLeave);
    $card.removeEventListener("focusin", this.onEnter);
    $card.removeEventListener("focusout", this.onLeave);
    this.$card = null;
  }

  private clearTimers(): void {
    if (this.openTimer != null) window.clearTimeout(this.openTimer);
    if (this.closeTimer != null) window.clearTimeout(this.closeTimer);
    this.openTimer = null;
    this.closeTimer = null;
  }

  private open(): void {
    const props = this.props;
    const $t = this.$trigger;
    if (props == null || $t == null || this.instance != null) return;
    const $card = Popover.makeWith({
      $content: props.$content,
      role: "none",
      label: null,
      placement: null,
      arrow: false,
      onDismiss: null,
    });
    // The card is part of the hover target: entering it cancels the close.
    $card.addEventListener("pointerenter", this.onEnter);
    $card.addEventListener("pointerleave", this.onLeave);
    $card.addEventListener("focusin", this.onEnter);
    $card.addEventListener("focusout", this.onLeave);
    this.$card = $card;
    this.instance = Anchor.reveal({
      $anchor: $t,
      $content: $card,
      position: props.placement ?? Position.BOTTOM_CENTER,
      escapeContainer: true,
      dismissOnClickOutside: true,
      onDismiss: () => {
        this.instance = null;
        this.releaseCard();
        this.clearTimers();
      },
    });
  }

  private close(): void {
    this.clearTimers();
    const instance = this.instance;
    this.instance = null;
    this.releaseCard();
    instance?.dismiss();
  }

  static $styles = [
    css`
      :host {
        display: contents;
      }
    `,
  ];

  static $html = html``;
}

export namespace HoverCard {
  export type Props = {
    $content: () => HTMLElement;
    /** Default 300ms — long enough that a pointer passing through opens nothing. */
    openDelayMs: Option<number>;
    /** Default 200ms — long enough to cross the gap into the card. */
    closeDelayMs: Option<number>;
    placement: Option<Position>;
  };
}
