import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Constants } from "@tento-core/constants";
import { CSSLength } from "@tento-ui/css-length";
import { DomUtils } from "@tento-ui/dom";
import { $$ } from "@tento-ui/fastdom";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";

@component({
  name: "std-split-buttons",
})
export class SplitButtons extends LonaWebComponent {
  onChange?: (split: CSSLength) => void = Constants.EMPTY_FUNCTION;

  private $split50 = this.$("split-50");
  private $split66 = this.$("split-66");
  private $split100 = this.$("split-100");

  connectedCallback() {
    // ARIA accessibility setup
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", "Split view layout");
    this.$split50.setAttribute("aria-label", "50% split view");
    this.$split50.setAttribute("aria-pressed", "true");
    this.$split66.setAttribute("aria-label", "66% split view");
    this.$split66.setAttribute("aria-pressed", "false");
    this.$split100.setAttribute("aria-label", "Full width view");
    this.$split100.setAttribute("aria-pressed", "false");

    GESTURE_MANAGER.addPointerEvent(this.$split50, {
      onClick: () => {
        $$.mutate(() =>
          DomUtils.setSelected(
            this.$qsa(".split-button"),
            ($e) => $e === this.$split50,
          ),
        );
        this.onChange?.(CSSLength.fromVw(50));
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$split66, {
      onClick: () => {
        $$.mutate(() =>
          DomUtils.setSelected(
            this.$qsa(".split-button"),
            ($e) => $e === this.$split66,
          ),
        );
        this.onChange?.(CSSLength.fromVw(66));
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$split100, {
      onClick: () => {
        $$.mutate(() =>
          DomUtils.setSelected(
            this.$qsa(".split-button"),
            ($e) => $e === this.$split100,
          ),
        );
        this.onChange?.(CSSLength.fromVw(100));
      },
    });
  }

  bind(props: SplitButtons.Props): this {
    this.onChange = props.onChange ?? Constants.EMPTY_FUNCTION;
    this.setSelected(props.selected ?? CSSLength.fromVw(50));
    return this;
  }

  setSelected(split: CSSLength): void {
    const $selected: Option<HTMLElement> = split.match({
      vw: (n) => {
        switch (n) {
          case 50:
            return this.$split50;
          case 66:
            return this.$split66;
          case 100:
            return this.$split100;
        }
        return undefined;
      },
      px: () => undefined,
      percent: () => undefined,
    });

    $$.mutate(() => {
      DomUtils.setSelected(
        this.$qsa(".split-button"),
        ($e) => $e === $selected,
      );
      // Update aria-pressed for screen readers
      this.$split50.setAttribute("aria-pressed", String($selected === this.$split50));
      this.$split66.setAttribute("aria-pressed", String($selected === this.$split66));
      this.$split100.setAttribute("aria-pressed", String($selected === this.$split100));
    });
  }

  static $styles = [
    css`
      :host {
        display: flex;
        gap: 0px;
      }

      .split-button {
        height: 20px;
        width: 20px;
        border-radius: 4px;
        color: var(--text-sec);
        padding: 0px;
        margin-right: 8px;
        background: transparent;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background-color 0.3s ease, color 0.3s ease;
      }

      .split-button:hover {
        background-color: var(--bg-hover);
      }

      .split-button[selected] {
        color: var(--text-pri);
        background-color: var(--bg-surface-light);
      }

      .split-button:last-child {
        margin-right: 0px;
      }

      .split-button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <button id="split-50" class="split-button">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect
          x="0.75"
          y="1.75"
          width="14.5"
          height="12.5"
          rx="2.75"
          stroke="currentColor"
          stroke-width="1.5"
        />
        <path
          d="M2.5 5.5C2.5 4.79993 2.5 4.4499 2.63624 4.18251C2.75608 3.94731 2.94731 3.75608 3.18251 3.63624C3.4499 3.5 3.79993 3.5 4.5 3.5H5.5C6.20007 3.5 6.5501 3.5 6.81749 3.63624C7.05269 3.75608 7.24392 3.94731 7.36376 4.18251C7.5 4.4499 7.5 4.79993 7.5 5.5V10.5C7.5 11.2001 7.5 11.5501 7.36376 11.8175C7.24392 12.0527 7.05269 12.2439 6.81749 12.3638C6.5501 12.5 6.20007 12.5 5.5 12.5H4.5C3.79993 12.5 3.4499 12.5 3.18251 12.3638C2.94731 12.2439 2.75608 12.0527 2.63624 11.8175C2.5 11.5501 2.5 11.2001 2.5 10.5V5.5Z"
          fill="currentColor"
        />
      </svg>
    </button>
    <button id="split-66" class="split-button">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect
          x="0.75"
          y="1.75"
          width="14.5"
          height="12.5"
          rx="2.75"
          stroke="currentColor"
          stroke-width="1.5"
        />
        <path
          d="M2.5 5.5C2.5 4.79993 2.5 4.4499 2.63624 4.18251C2.75608 3.94731 2.94731 3.75608 3.18251 3.63624C3.4499 3.5 3.79993 3.5 4.5 3.5H8.5C9.20007 3.5 9.5501 3.5 9.81749 3.63624C10.0527 3.75608 10.2439 3.94731 10.3638 4.18251C10.5 4.4499 10.5 4.79993 10.5 5.5V10.5C10.5 11.2001 10.5 11.5501 10.3638 11.8175C10.2439 12.0527 10.0527 12.2439 9.81749 12.3638C9.5501 12.5 9.20007 12.5 8.5 12.5H4.5C3.79993 12.5 3.4499 12.5 3.18251 12.3638C2.94731 12.2439 2.75608 12.0527 2.63624 11.8175C2.5 11.5501 2.5 11.2001 2.5 10.5V5.5Z"
          fill="currentColor"
        />
      </svg>
    </button>
    <button id="split-100" class="split-button">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect
          x="0.75"
          y="1.75"
          width="14.5"
          height="12.5"
          rx="2.75"
          stroke="currentColor"
          stroke-width="1.5"
        />
        <path
          d="M2.5 5.5C2.5 4.79993 2.5 4.4499 2.63624 4.18251C2.75608 3.94731 2.94731 3.75608 3.18251 3.63624C3.4499 3.5 3.79993 3.5 4.5 3.5H11.5C12.2001 3.5 12.5501 3.5 12.8175 3.63624C13.0527 3.75608 13.2439 3.94731 13.3638 4.18251C13.5 4.4499 13.5 4.79993 13.5 5.5V10.5C13.5 11.2001 13.5 11.5501 13.3638 11.8175C13.2439 12.0527 13.0527 12.2439 12.8175 12.3638C12.5501 12.5 12.2001 12.5 11.5 12.5H4.5C3.79993 12.5 3.4499 12.5 3.18251 12.3638C2.94731 12.2439 2.75608 12.0527 2.63624 11.8175C2.5 11.5501 2.5 11.2001 2.5 10.5V5.5Z"
          fill="currentColor"
        />
      </svg>
    </button>
  `;
}

export namespace SplitButtons {
  export type Props = {
    onChange?: (split: CSSLength) => void;
    selected?: Option<CSSLength>;
  };
}
