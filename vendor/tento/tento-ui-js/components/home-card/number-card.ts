import "@tento-ui/components/input/number-input";

import { NumberInput } from "@tento-ui/components/input/number-input";
import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";

/** A home card that edits a number row's value for a day. */
@component({ name: "std-number-card" })
export class SheetRowNumberCard extends LonaWebComponent {
  private $input: NumberInput = this.hydrate("input");

  static makeWith(props: SheetRowNumberCard.Props): SheetRowNumberCard {
    return SheetRowNumberCard.make().bind(props);
  }

  bind(props: SheetRowNumberCard.Props): this {
    this.$input.enableEditing();
    this.$input.bind(props.value, { placeholder: "0" });
    this.$input.setCallbacks({
      onEditingFinished: props.onUpdate,
    });
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        height: 100%;
      }
      std-col {
        align-items: stretch;
        justify-content: center;
        height: 100%;
        position: relative;
        padding: 12px;
        padding-bottom: 80px;
      }
      .label {
        margin-bottom: 8px;
        color: var(--text-ter);
      }
      #input {
        height: 40px;
        background: var(--bg);
        padding: 12px;
        border-radius: 8px;
      }
    `,
  ];

  static $html = html`
    <std-col>
      <p class="label">Add an entry</p>
      <std-number-input id="input"></std-number-input>
    </std-col>
  `;
}

export namespace SheetRowNumberCard {
  export type Props = {
    value: Option<number>;
    onUpdate: (value: Option<number>) => void;
  };
}
