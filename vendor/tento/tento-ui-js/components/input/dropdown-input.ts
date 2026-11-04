import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({
  name: "std-dropdown-input",
})
export class DropdownInput extends LonaWebComponent {
  private $labelText = this.hydrate("label-text");
  private $currentValue = this.hydrate("current-value");

  static makeWith(props: {
    label: string;
    currentValue: string;
    dropdown: HTMLElement;
  }): DropdownInput {
    const instance = DropdownInput.make();
    instance.bind(props);
    return instance;
  }

  bind(props: {
    label: string;
    currentValue: string;
    dropdown: HTMLElement;
  }): void {
    this.$labelText.textContent = props.label;
    this.$currentValue.textContent = props.currentValue;

    // Clear existing dropdown and add new one
    this.clearChildren();
    props.dropdown.slot = "dropdown";
    props.dropdown.style.marginBottom = "8px";
    this.appendChild(props.dropdown);
  }

  updateCurrentValue(value: string): void {
    this.$currentValue.textContent = value;
  }

  static $styles = [
    css`
      :host {
        padding: 6px 8px;
        margin-bottom: var(--form-input-margin-bottom, 0px);
      }

      #label-text {
        color: var(--text-sec);
        --font-size: var(--p-size);
      }

      #current-value {
        color: var(--text-ter);
        --font-size: var(--small-size);
      }

      #label-row {
        justify-content: space-between;
        align-items: center;
        margin-block: 8px;
        margin-inline: 4px;
      }
    `,
  ];

  static $html = html`
    <std-col>
      <std-row id="label-row">
        <p id="label-text"></p>
        <p id="current-value"></p>
      </std-row>
      <slot name="dropdown"></slot>
    </std-col>
  `;
}
