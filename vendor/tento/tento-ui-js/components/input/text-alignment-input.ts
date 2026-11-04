import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { LonaIcons, TextCenter, TextLeft, TextRight } from "../../ui/icons";
import { ButtonGroupRow } from "../button-group-row";

export type TextAlignment = "left" | "center" | "right";

@component({
  name: "std-text-alignment-input",
})
export class TextAlignmentInput extends LonaWebComponent {
  private alignment: TextAlignment = "left";
  private $buttonGroup: ButtonGroupRow<TextAlignment> =
    this.hydrate("button-group");
  onAlignmentChange?: (alignment: TextAlignment) => void;

  bind(props: TextAlignmentInput.Props): void {
    this.alignment = props.alignment ?? "left";
    this.onAlignmentChange = props.onAlignmentChange;

    const entries: ButtonGroupRow.Item<TextAlignment>[] = [
      {
        identifier: "left",
        label: LonaIcons.make(TextLeft, { sizePx: 16 }),
      },
      {
        identifier: "center",
        label: LonaIcons.make(TextCenter, { sizePx: 16 }),
      },
      {
        identifier: "right",
        label: LonaIcons.make(TextRight, { sizePx: 16 }),
      },
    ];

    this.$buttonGroup.bind(this.alignment, entries);
    this.$buttonGroup.onSelected = (alignment: TextAlignment) => {
      this.alignment = alignment;
      this.onAlignmentChange?.(alignment);
    };
  }

  static makeWith(props: TextAlignmentInput.Props): TextAlignmentInput {
    const component = TextAlignmentInput.make();
    component.bind(props);
    return component;
  }

  getAlignment(): TextAlignment {
    return this.alignment;
  }

  setAlignment(alignment: TextAlignment): void {
    this.alignment = alignment;
    this.$buttonGroup.bindSelected(alignment, false);
  }

  static $styles = [
    css`
      :host {
        display: block;
      }
    `,
  ];

  static $html = html`
    <std-button-group-row id="button-group"></std-button-group-row>
  `;
}

export namespace TextAlignmentInput {
  export interface Props {
    alignment?: Option<TextAlignment>;
    onAlignmentChange?: (alignment: TextAlignment) => void;
  }
}
