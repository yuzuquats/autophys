import "../editable-text";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { NumberFormat } from "@tento-core/number-format";
import { Typography } from "../../ui/typography";
import { EditableText } from "../editable-text";
import { NumberFormatter } from "@tento-ui/number-formatter";

@component({
  name: "std-number-input-accessory",
})
export class NumberInputAccessory extends LonaWebComponent {
  private $root = this.hydrate<EditableText>("root");

  onChange: (n: Option<number>) => void = Constants.EMPTY_FUNCTION;
  onEditingFinished: (n: Option<number>) => void = Constants.EMPTY_FUNCTION;

  private format: NumberInputAccessory.Format = "default";
  private placeholder: string = "";

  static makeWith(props: NumberInputAccessory.Props): NumberInputAccessory {
    const $c = NumberInputAccessory.make();
    $c.bind(props);
    return $c;
  }

  constructor() {
    super();
    this.addPointerEvent({
      onClick: () => {
        if (!this.$root.editable()) return;
        this.$root.enableEditing(true);
      },
    });
  }

  bind(props: NumberInputAccessory.Props): this {
    this.format = props.format ?? "default";
    this.placeholder = props.placeholder ?? "0";
    this.onChange = props.onChange ?? Constants.EMPTY_FUNCTION;
    this.onEditingFinished =
      props.onEditingFinished ?? Constants.EMPTY_FUNCTION;

    const formatter = NumberFormatter.formatters.get()[this.format];

    this.$root.bind(
      props.value != null ? NumberFormatter.format(formatter, props.value) : null,
      this.placeholder,
    );
    this.$root.controller.onEnterKey = () => {
      this.$root.blur();
    };
    this.$root.controller.onTextChange = (t) => {
      const newNumber = t ? NumberFormat.parse(t) : null;
      this.onChange(newNumber);
    };
    this.$root.controller.onEditingFinished = () => {
      const rawText = this.$root.text;
      const newNumber = rawText ? NumberFormat.parse(rawText) : null;
      this.$root.bind(
        newNumber != null ? NumberFormatter.format(formatter, newNumber) : null,
        this.placeholder,
      );
      this.onEditingFinished(newNumber);
    };
    this.$root.enableEditing();

    return this;
  }

  toggleEditable(f: boolean) {
    this.$root.toggleEditable(f);
  }

  static $styles: Style.Compat[] = [
    Typography.$style,
    css`
      :host {
        display: block;
        align-self: stretch;
        height: 100%;
        padding-inline: 8px;
        background: var(--bg);
        border-radius: 8px;
        height: 32px;
        box-shadow: var(--box-shadow-very-light);
        cursor: text;
        min-width: 40px;
      }

      :host(:focus-within) {
        outline: 2px solid var(--blue);
        outline-offset: -2px;
      }

      #root {
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        --text-align: center;
        --placeholder-left: unset;
        --placeholder-right: 0px;
        color: var(--text-sec);
        --font-size: var(--small-size);
        white-space: nowrap;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-editable-text id="root"></std-editable-text>
  `;
}

export namespace NumberInputAccessory {
  export type Format = "default" | "currency" | "percentage";

  export interface Props {
    value: Option<number>;
    format?: Option<Format>;
    placeholder?: Option<string>;
    onChange?: Option<(n: Option<number>) => void>;
    onEditingFinished?: Option<(n: Option<number>) => void>;
  }
}
