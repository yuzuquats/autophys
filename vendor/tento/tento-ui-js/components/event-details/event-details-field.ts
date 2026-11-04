import "../input/recurrence-input";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";

@component({
  name: "std-event-details-field",
})
export class EventDetailsField<
  Content extends Option<HTMLElement> = null,
> extends LonaWebComponent {
  onClickOutside: Option<() => void>;

  static makeText(label: string): EventDetailsField<HTMLParagraphElement> {
    const $e = EventDetailsField.make();
    const $label = Typography.p(label, "small");
    $e.appendChild($label);
    return $e as EventDetailsField<HTMLParagraphElement>;
  }

  static makeWith<T extends HTMLElement>(
    $child: T,
    options?: Optional<{ padding: string }>,
  ): EventDetailsField<T> {
    const $e = EventDetailsField.make();
    $e.appendChild($child);
    $e.assignStyles({
      padding: options?.padding ?? "0px",
    });
    return $e as EventDetailsField<T>;
  }

  connectedCallback() {
    GESTURE_MANAGER.setOnClickOutside(this, () => this.onClickOutside?.());
  }

  disconnectedCallback() {
    GESTURE_MANAGER.clearOnClickOutside(this);
  }

  // note: no type checking
  get $content(): Content {
    return this.children[0] as Content;
  }

  get $label(): HTMLElement {
    return this.$("label");
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: flex;
        box-sizing: border-box;
        align-items: center;
        min-height: 36px;
        min-width: 0;
        padding: 12px;
        border-radius: 4px;
        background: var(--bg-surface-light);
      }

      :host([first-visible]) {
        border-top-left-radius: 10px;
        border-top-right-radius: 10px;
      }

      :host([last-visible]) {
        border-bottom-left-radius: 10px;
        border-bottom-right-radius: 10px;
      }

      #label {
        --font-size: var(--small-size);
      }

      #root {
        width: 100%;
        min-width: 0;
        align-items: center;
      }

      slot::slotted(*):focus {
        outline: none;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root"><slot></slot></std-row>
  `;
}
