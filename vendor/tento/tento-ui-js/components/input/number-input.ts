import "../editable-text";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { NumberFormat } from "@tento-core/number-format";
import { EditableText } from "../editable-text";
import { Shimmer } from "../shimmer";
import { NumberFormatter } from "@tento-ui/number-formatter";

@component({
  name: "std-number-input",
})
export class NumberInput extends LonaWebComponent {
  private $root = this.hydrate<EditableText>("root");

  onChange: (n: Option<number>) => void = Constants.EMPTY_FUNCTION;
  onEditingFinished: (n: Option<number>) => void = Constants.EMPTY_FUNCTION;

  constructor() {
    super();
    this.addPointerEvent({
      onClick: () => {
        if (!this.$root.editable()) return;
        this.$root.enableEditing(true);
      },
    });
  }

  toggleEditable(f: boolean) {
    this.$root.toggleEditable(f);
  }

  enableEditing(focus: boolean = false) {
    this.$root.enableEditing(focus);
  }

  setCallbacks(
    callbacks: Optional<{
      onChange: (n: Option<number>) => void;
      onEditingFinished: (n: Option<number>) => void;
    }>,
  ) {
    this.onChange = callbacks.onChange ?? Constants.EMPTY_FUNCTION;
    this.onEditingFinished =
      callbacks.onEditingFinished ?? Constants.EMPTY_FUNCTION;
  }

  bind(
    data: Option<number>,
    options?: Optional<{
      format: "number" | "currency" | "percentage";
      formatter: Intl.NumberFormat;
      placeholder: string;
      loading: boolean;
    }>,
  ) {
    // Toggle loading state
    this.toggleAttribute("loading", options?.loading ?? false);
    if (options?.loading) {
      return;
    }

    // Prefer caller-provided formatter when present.
    // Otherwise map format type to formatter key ("number" -> "default").
    const formatter =
      options?.formatter ??
      NumberFormatter.formatters.get()[
        (options?.format === "number"
          ? "default"
          : (options?.format ?? "default")) as
          | "default"
          | "currency"
          | "percentage"
      ];

    this.$root.bind(
      data != null ? NumberFormatter.format(formatter, data) : null,
      options?.placeholder,
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
        options?.placeholder,
      );
      this.onEditingFinished(newNumber);
    };
  }

  static $styles: Style.Compat[] = [
    Shimmer.$cellLoading,
    css`
      :host {
        box-sizing: border-box;
        --cell-loading-shimmer-inset-x: 2px;
        --text-align: end;
        --placeholder-left: unset;
        --placeholder-right: 0px;
        display: flex;
        justify-content: center;
        align-items: center;
        cursor: text;
      }

      :host([opaque]) {
        width: 48px;
        height: 38px;
        background: var(--bg-surface-light);
        border-radius: 8px;
        border: 2px solid transparent;
        transition: border-color 0.3s ease;
      }

      :host([opaque]):focus-within {
        border-color: var(--blue);
      }

      #root {
        width: 100%;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-editable-text id="root"></std-editable-text>
    <slot></slot>
  `;
}
