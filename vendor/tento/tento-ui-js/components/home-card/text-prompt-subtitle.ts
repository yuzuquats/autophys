import "@tento-ui/components/prosemirror";

import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import { CellGroup } from "@tento-ui/components/sheet/cell-group";
import { NaiveDate } from "@tento-chrono";

/**
 * The dated prompt line under a text card, with an input that submits an
 * entry.
 */
@component({
  name: "std-text-prompt-subtitle",
})
export class TextPromptSubtitle extends LonaWebComponent {
  private $dateLabel: HTMLElement = this.$("date-label");
  private $input: ProseMirrorEditor = this.hydrate("input");
  private onSubmit: Option<(text: string) => void>;

  static makeWith(props: TextPromptSubtitle.Props): TextPromptSubtitle {
    const $c = TextPromptSubtitle.make();
    $c.bind(props);
    return $c;
  }

  bind(props: TextPromptSubtitle.Props): this {
    this.onSubmit = props.onSubmit;

    const tooltip = CellGroup.tooltipText(props.date);
    this.$dateLabel.textContent = tooltip.subtitle
      ? `${tooltip.title} (${tooltip.subtitle})`
      : tooltip.title;

    // Lazy: the entry is painted as static markup until the user reaches for
    // the input. A hidden list face, rebound on every keystroke in the card
    // face's editor, then repaints instead of rebuilding an editor view.
    this.$input.bind({
      lazy: true,
      markdown: props.value ?? "",
      placeholder: props.placeholder ?? "",
      editable: true,
      onUpdate: (markdown) => {
        this.onSubmit?.(markdown);
      },
    });

    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 4px;
        margin-inline: 4px;
      }

      #date-label {
        font-size: var(--text-12px);
        color: var(--text-ter);
        display: none;
      }

      #content {
        background: var(--bg);
        border-radius: 16px;
        border-top-left-radius: 8px;
        border-top-right-radius: 8px;
        transition: box-shadow 0.3s ease;
      }

      #content:hover {
        box-shadow: var(--box-shadow-light);
      }

      #input {
        width: 100%;
        color: var(--text-pri);
        --editor-padding: 12px;
        border: 1px solid var(--divider);
        min-height: 52px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <p id="date-label"></p>
    <div id="content">
      <std-prosemirror id="input"></std-prosemirror>
    </div>
  `;
}

export namespace TextPromptSubtitle {
  export interface Props {
    date: NaiveDate.Partial;
    /** The entry the input shows (markdown); empty shows the placeholder. */
    value?: Option<string>;
    placeholder?: Option<string>;
    onSubmit?: (text: string) => void;
  }
}
