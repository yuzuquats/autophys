import "../token/token";
import "../typeahead/typeahead";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";
import { Token } from "../token/token";
import { Typeahead } from "../typeahead/typeahead";

// Tokens in, typeahead out. `std-dropdown` selects one. This composes
// `std-token` for the chosen values and `std-typeahead` for the search — the
// typeahead's suggestions are the options not yet chosen, filtered by the
// query, or every remaining option when `searchable` is off — and it lands
// last because it is nothing but its two parts. `values` is a prop; the
// field rebinds on change and a polite live region announces the count.
@component({ name: "std-multi-select" })
export class MultiSelect extends LonaWebComponent {
  private $tokens: HTMLElement = this.$("tokens");
  private $search: Typeahead = this.hydrate("search");
  private $live: HTMLElement = this.$("live");
  private props: Option<MultiSelect.Props>;

  bind(props: MultiSelect.Props): this {
    this.props = props;
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", props.label);
    DomUtils.clearChildren(this.$tokens);
    for (const id of props.values) {
      const opt = props.options.find((o) => o.id === id);
      this.$tokens.appendChild(
        Token.makeWith({ label: opt?.label ?? id, removable: true, tone: null, onRemove: () => this.dropValue(id) }),
      );
    }
    this.$search.bind({
      value: "",
      placeholder: props.placeholder ?? (props.searchable ? "Search" : "Add"),
      suggest: async (q) => this.remaining(q),
      onSelect: (id) => this.add(id),
      onInput: () => {},
      debounceMs: props.searchable ? 120 : 0,
      allowFreeText: false,
      label: props.label,
    });
    this.$live.textContent = `${props.values.length} selected`;
    return this;
  }

  private remaining(q: string): Typeahead.Item[] {
    const props = this.props;
    if (props == null) return [];
    const needle = q.trim().toLowerCase();
    return props.options
      .filter((o) => !props.values.includes(o.id))
      .filter((o) => !props.searchable || needle === "" || o.label.toLowerCase().includes(needle))
      .map((o) => ({ id: o.id, label: o.label, $row: null }));
  }

  private emit(values: string[]): void {
    const props = this.props;
    if (props == null) return;
    this.bind({ ...props, values });
    props.onChange(values);
  }

  private add(id: string): void {
    const props = this.props;
    if (props == null || props.values.includes(id)) return;
    this.emit([...props.values, id]);
  }

  private dropValue(id: string): void {
    const props = this.props;
    if (props == null) return;
    this.emit(props.values.filter((v) => v !== id));
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    DomUtils.clearChildren(this.$tokens);
    this.$live.textContent = "";
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: MultiSelect.Props): MultiSelect {
    return MultiSelect.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: block;
        width: 100%;
      }

      #tokens {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 4px;
      }

      #tokens:empty {
        display: none;
      }

      /* The typeahead's label is the field's one visible label. */

      #live {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
      }
    `,
  ];

  static $html = html`
    <div id="tokens"></div>
    <std-typeahead id="search"></std-typeahead>
    <span id="live" aria-live="polite"></span>
  `;
}

export namespace MultiSelect {
  export type Option_ = { id: string; label: string };
  export type Props = {
    options: Option_[];
    values: string[];
    onChange: (values: string[]) => void;
    /** Filter options by the typed text; off shows every remaining option. */
    searchable: boolean;
    placeholder: Option<string>;
    label: string;
  };
}
