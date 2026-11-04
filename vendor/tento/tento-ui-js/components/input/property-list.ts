import "../round";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { Typography } from "../../ui/typography";
import { Round } from "../round";
import { NumberInput } from "./number-input";
import { Button } from "../button/button";

@component({
  name: "std-property-list",
})
export class PropertyList extends LonaWebComponent {
  $bg = this.hydrate<Round>("bg").bind(Round.Props.FLAT_CARD);

  static makeWith(items: PropertyList.Items): PropertyList {
    return PropertyList.make().bind(items);
  }

  bind(items: PropertyList.Items): this {
    this.clearChildren();

    const orderedItems: PropertyList.Item[] = [];
    for (const key in items) {
      orderedItems.push(items[key]);
    }
    orderedItems.sort((a, b) => a.order - b.order);

    for (const item of orderedItems) {
      this.appendChild(
        PropertyListItem.makeWith({
          label: item.label,
          value: item.$e,
          valueLayout: item.valueLayout,
          valueAlign: item.valueAlign,
        }),
      );
    }
    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      #root {
        position: relative;
        padding: 16px 24px;
        gap: var(--plist-gap, 0px);
        min-height: inherit;
      }

      :host([flat]) #bg {
        display: none;
      }

      :host([flat]) #root {
        padding: 0px;
      }
    `,
    css`
      input[type="color"] {
        -webkit-appearance: none; /* Safari/Chrome */
        -moz-appearance: none;    /* Firefox */
        appearance: none;
        border: none;
        padding: 0;
        background: none;
        cursor: pointer;
        border-radius: 8px;

        width: 32px;
        height: 24px;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <std-round id=bg floating></std-round>
      <slot></slot>
    </std-col>
  `;
}

export namespace PropertyList {
  export type Items = Record<string, Item>;
  export type Item = {
    $e: HTMLElement;
    label: string;
    order: number;
    valueLayout?: "stretch" | "end";
    /** Which edge the value sits against. `std-property-list-item` has
     * always understood this; the list simply never passed it on, so a
     * caller wanting left-aligned values had no way to ask. */
    valueAlign?: "start" | "end";
  };
}

@component({
  name: "std-property-list-item",
})
export class PropertyListItem extends LonaWebComponent {
  static makeWith(props: PropertyListItem.BindProps): PropertyListItem {
    return PropertyListItem.make().bind(props);
  }

  bind(props: PropertyListItem.BindProps): this {
    this.clearChildren();
    this.$("label-text").textContent = props.label;

    if (props.icon) {
      props.icon.slot = "icon";
      this.appendChild(props.icon);
    }

    const $label = this.$("label") as HTMLButtonElement;
    $label.onclick = props.onLabelClick ? () => props.onLabelClick!() : null;

    this.toggleAttribute("value-start", props.valueAlign === "start");

    if (typeof props.value === "string") {
      const $value = Typography.p(props.value);
      $value.slot = "value";
      this.appendChild($value);
      this.removeAttribute("component-value");
      this.removeAttribute("value-end");
    } else if (props.valueLayout === "stretch") {
      const $value = props.value;
      $value.slot = "value";
      // MIN-height, not height: a fixed height clips a value long enough
      // to wrap and drops its first line off the label's baseline. The row
      // still keeps its rhythm when the value is one line.
      $value.style.minHeight = "var(--plist-height, 28px)";
      $value.style.flex = "1";
      this.appendChild($value);
      this.setAttribute("component-value", "");
      this.removeAttribute("value-end");
    } else {
      const $value = props.value;
      $value.slot = "value";
      this.appendChild($value);
      this.removeAttribute("component-value");
      this.setAttribute("value-end", "");
    }
    return this;
  }

  bindLabel(label: string): this {
    this.$("label-text").textContent = label;
    return this;
  }

  static $styles: Style.Compat[] = [
    Button.$style,
    css`
      #root {
        min-height: var(--plist-height, 28px);
        /* Centred by default. A caller whose values wrap wants the label
           beside the value's FIRST line, not floating at its middle. */
        align-items: var(--plist-align, center);
        color: var(--text-sec);
        gap: 8px;
      }

      /* The two cells share ONE inset, so a label and a text value sit in
         boxes of the same shape and their first lines start on the same
         y. Declared as a fallback here rather than a value on the list's
         #root: #root sits below the host, so a value declared there would
         beat the caller's and the knob would be unusable. */
      #label {
        gap: 6px;
        min-width: var(--label-min-width);
        min-height: var(--plist-height, 28px);
        padding: var(--plist-pad, 4px 8px);
        border-radius: 4px;
        justify-content: start;
      }

      /* --label-size is defaulted HERE, at the one place that reads it.
         It used to be declared on the list's #root as var(--small-size),
         which sits below the host: a caller setting --label-size on the
         <std-property-list> element had it overwritten a level down and no
         way to find out. Same defect as the one the #label note describes,
         and the reason the transcript's key/value grid could not put its
         label and its value on one size. */
      #label-text {
        --font-size: var(--label-size, var(--small-size));
        color: var(--text-ter);
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      ::slotted([slot=icon]) {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        margin-right: 4px;
        color: var(--text-ter);
      }

      #value-cell {
        flex: 1;
        display: flex;
        align-items: var(--plist-align, center);
        min-height: var(--plist-height, 28px);
        padding: var(--plist-pad, 4px 8px);
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 0.15s ease;
        justify-content: flex-end;
      }

      #value-cell:hover {
        background-color: var(--bg-hover);
      }

      :host([active]) #value-cell {
        background-color: var(--bg-hover);
      }

      /* A component value normally brings its own box, so the cell stops
         adding one — a NumberInput inside a padded cell is double-inset.
         That is wrong for the other case, a slotted piece of plain text,
         which has no box and then sits a padding's worth above the label
         beside it. The caller knows which it passed, so it says. */
      :host([component-value]) #value-cell {
        padding: var(--plist-value-pad, 0px);
      }

      :host([value-end]) #value-cell {
        justify-content: flex-end;
      }

      :host([value-start]) #value-cell {
        justify-content: flex-start;
      }

      /* Read-only display rows — no edit affordances: the label is a plain
         caption, the value plain selectable text. */
      :host([display]) #label {
        pointer-events: none;
        padding-left: 0px;
      }

      :host([display]) #value-cell {
        cursor: auto;
        user-select: text;
        justify-content: flex-start;
      }

      :host([display]) #value-cell:hover {
        background-color: transparent;
      }

      /* Stacked display: label ABOVE a full-width value — the long-text form
         of the same list (prose, paths, evidence). The vertical padding is
         the block's own air: a 26px row spaces itself through min-height, so
         a stacked block must bring the same kind of gap or a mixed list
         (row above, block below) collapses tight. */
      :host([stacked]) #root {
        flex-direction: column;
        align-items: stretch;
        gap: var(--plist-stacked-gap, 12px);
        min-height: 0px;
        padding: 8px 0px;
      }

      :host([stacked]) #label {
        min-height: 0px;
        padding: 0px;
      }

      :host([stacked]) #value-cell {
        min-height: 0px;
        padding: 0px 0px 0px 0px;
      }

      :host([stacked]) ::slotted([slot="value"]) {
        overflow-wrap: anywhere;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <button id="label" flat>
        <slot name="icon"></slot>
        <p id="label-text"></p>
      </button>
      <div id="value-cell">
        <slot name=value></slot>
      </div>
    </std-row>
  `;
}

export namespace PropertyListItem {
  export type BindProps = {
    label: string;
    value: string | HTMLElement;
    icon?: Element;
    onLabelClick?: () => void;
    valueLayout?: "stretch" | "end";
    valueAlign?: "start" | "end";
  };

  /** Value stretches full width of the value cell. */
  export function FullWidth(
    props: Omit<BindProps, "valueLayout">,
  ): PropertyListItem {
    return PropertyListItem.makeWith({ ...props, valueLayout: "stretch" });
  }

  /** Value floats to the end of the value cell. */
  export function Default(
    props: Omit<BindProps, "valueLayout">,
  ): PropertyListItem {
    return PropertyListItem.makeWith({ ...props, valueLayout: "end" });
  }

  /** Read-only display row: label caption beside a start-aligned, selectable
   * value. No hover states, no click affordances — a fact, not an input. */
  export function Display(
    props: Omit<BindProps, "valueLayout" | "valueAlign">,
  ): PropertyListItem {
    const $item = PropertyListItem.makeWith({ ...props, valueAlign: "start" });
    $item.toggleAttribute("display", true);
    return $item;
  }

  /** Read-only stacked field: label ABOVE a full-width value — the display
   * form for prose, paths, and other long values. */
  export function Stacked(
    props: Omit<BindProps, "valueLayout" | "valueAlign">,
  ): PropertyListItem {
    const $item = PropertyListItem.makeWith({ ...props, valueAlign: "start" });
    $item.toggleAttribute("display", true);
    $item.toggleAttribute("stacked", true);
    return $item;
  }

  export function makeNumberInput(props: {
    initialValue: number;
    onEditingFinished: (n: Option<number>) => void;
    editable: boolean;
  }) {
    const $n = NumberInput.make();
    $n.bind(props.initialValue);
    $n.assignStyles({
      position: "relative",
      minWidth: "12px",
      padding: "4px 12px",
    });
    $n.slot = "value";
    $n.onEditingFinished = props.onEditingFinished;
    $n.toggleEditable(props.editable);

    if (props.editable) {
      const $card = Round.makeWith({
        bg: "var(--bg-surface-light)",
        radius: 8,
        shadow: false,
      }).assignStyles({
        position: "absolute",
        cursor: "text",
      });
      $card.addPointerEvent({
        onClick: () => $n.enableEditing(true),
      });
      $n.appendChild($card);
    }
    return $n;
  }
}
