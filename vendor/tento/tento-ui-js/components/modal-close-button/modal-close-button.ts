import "../icon-button";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { IconButton } from "../icon-button";
import { LonaIcons, XIcon } from "../../ui/icons";
import { GESTURE_MANAGER } from "../../gesture-manager";

/**
 * A close button that displays a shadow when associated content is scrolled.
 * Commonly used in modal headers.
 *
 * Usage:
 * ```typescript
 * const $close = ModalCloseButton.make();
 * $close.bind({
 *   onDismiss: () => { ... },
 *   scrollSource: $scrollableContent,
 * });
 * ```
 */
@component({ name: "std-modal-close-button" })
export class ModalCloseButton extends LonaWebComponent {
  private $button: IconButton = this.hydrate("button");
  private scrollHandler: Option<() => void>;
  private currentScrollSource: Option<HTMLElement>;
  private onDismiss: Option<() => void>;

  /** Replace the complete binding; omitted callbacks and sources are cleared. */
  bind(props: ModalCloseButton.Props): this {
    this.onDismiss = props.onDismiss;
    this.bindPointerEvent();
    this.bindScrollSource(props.scrollSource);
    return this;
  }

  private bindPointerEvent(): void {
    GESTURE_MANAGER.unregister(this.$button);
    if (this.isConnected && this.onDismiss) {
      this.$button.addPointerEvent({ onClick: this.onDismiss });
    }
  }

  /**
   * Binds to a scrollable element and updates the shadow based on its scroll position.
   */
  bindScrollSource($scrollable: Option<HTMLElement>): this {
    if (this.scrollHandler && this.currentScrollSource) {
      this.currentScrollSource.removeEventListener(
        "scroll",
        this.scrollHandler,
      );
    }

    this.currentScrollSource = $scrollable;
    this.scrollHandler = undefined;
    this.removeAttribute("scrolled");
    this.removeAttribute("active");
    if (!$scrollable) return this;
    this.scrollHandler = () => {
      this.toggleAttribute("scrolled", $scrollable.scrollTop > 0);
      this.toggleAttribute("active", $scrollable.scrollHeight > $scrollable.clientHeight);
    };

    if (this.isConnected) $scrollable.addEventListener("scroll", this.scrollHandler);
    this.scrollHandler();

    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    GESTURE_MANAGER.unregister(this.$button);
    if (this.scrollHandler && this.currentScrollSource) {
      this.currentScrollSource.removeEventListener(
        "scroll",
        this.scrollHandler,
      );
    }
  }

  onRecycle(): void {
    this.bind({});
    super.onRecycle();
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        position: absolute;
        top: 16px;
        flex-shrink: 0;
        margin-bottom: 8px;
        margin-inline: 16px;
        z-index: 1;
        transition: box-shadow 0.3s ease;
        border-radius: 50%;
      }

      :host([scrolled]) {
        box-shadow: var(--box-shadow);
      }

      :host([active]) {
        box-shadow: var(--box-shadow-light);
      }

      :host([scrolled][active]) {
        box-shadow: var(--box-shadow);
      }

      #button {
        --std-icon-background-color: var(--bg);
        --std-icon-hover-color: var(--bg-hover-opaque);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-icon-button id="button"></std-icon-button>
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.$button.bind({
      content: LonaIcons.$svg(XIcon),
      sizePx: 28,
    });
    this.bindPointerEvent();
    if (this.currentScrollSource && this.scrollHandler) {
      this.currentScrollSource.addEventListener("scroll", this.scrollHandler);
      this.scrollHandler();
    }
  }
}

export namespace ModalCloseButton {
  export type Props = {
    onDismiss?: () => void;
    scrollSource?: Option<HTMLElement>;
  };
}
