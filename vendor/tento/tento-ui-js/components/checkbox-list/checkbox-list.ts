import "../controls/checkbox";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";
import { Checkbox } from "../controls/checkbox";

// The checkbox cells, grouped. `std-checkbox-cell` is a single row; this
// composes them under `role=group` with `values` as a prop and an optional
// select-all header whose `aria-checked` goes `mixed` when some are checked.
@component({ name: "std-checkbox-list" })
export class CheckboxList extends LonaWebComponent {
  private $head: HTMLElement = this.$("head");
  private $root: HTMLElement = this.$("root");
  private props: Option<CheckboxList.Props>;
  private $all: Option<Checkbox.Cell>;
  private mixed = false;

  /** `std-checkbox` writes `aria-checked` from its own state whenever it
   * connects, so the mixed value is written after it — here, and again in a
   * microtask after this host's subtree connects. */
  private applyMixed(): void {
    const $box = this.$all?.shadowRoot?.querySelector("std-checkbox")?.shadowRoot?.querySelector<HTMLElement>("#checkbox");
    if ($box == null) return;
    if (this.mixed) $box.setAttribute("aria-checked", "mixed");
    $box.toggleAttribute("mixed", this.mixed);
  }

  connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => this.applyMixed());
  }

  bind(props: CheckboxList.Props): this {
    this.props = props;
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", props.label);
    DomUtils.clearChildren(this.$root);
    DomUtils.clearChildren(this.$head);
    this.$all = null;
    if (props.selectAll != null) {
      const enabled = props.items.filter((it) => !it.disabled).map((it) => it.id);
      const checkedCount = enabled.filter((id) => props.values.includes(id)).length;
      const $all = Checkbox.Cell.makeWith({
        title: props.selectAll,
        options: {
          checked: enabled.length > 0 && checkedCount === enabled.length,
          onCheckedChanged: (_cell, checked) => this.setAll(checked),
        },
      });
      // `std-checkbox` draws its own control — no native input, so no
      // `indeterminate` — and its `role=checkbox` node is the `#checkbox` div
      // one shadow root down. The mixed state is written there; it moves into
      // the checkbox's own Props when its review fix lands.
      this.mixed = checkedCount > 0 && checkedCount < enabled.length;
      this.$head.appendChild($all);
      $all.toggleAttribute("mixed", this.mixed);
      this.$all = $all;
      this.applyMixed();
    }
    this.$head.toggleAttribute("hidden", props.selectAll == null);
    for (const item of props.items) {
      const $cell = Checkbox.Cell.makeWith({
        title: item.title,
        options: {
          $subtitle: item.subtitle == null ? undefined : Typography.small(item.subtitle),
          checked: props.values.includes(item.id),
          disabled: item.disabled,
          onCheckedChanged: (_cell, checked) => this.toggle(item.id, checked),
        },
      });
      this.$root.appendChild($cell);
    }
    return this;
  }

  private emit(values: string[]): void {
    const props = this.props;
    if (props == null) return;
    this.bind({ ...props, values });
    props.onChange(values);
  }

  private toggle(id: string, checked: boolean): void {
    const props = this.props;
    if (props == null) return;
    const values = checked ? [...new Set([...props.values, id])] : props.values.filter((v) => v !== id);
    this.emit(values);
  }

  private setAll(checked: boolean): void {
    const props = this.props;
    if (props == null) return;
    const enabled = props.items.filter((it) => !it.disabled).map((it) => it.id);
    const locked = props.values.filter((v) => props.items.find((it) => it.id === v)?.disabled);
    this.emit(checked ? [...new Set([...locked, ...enabled])] : locked);
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$all = null;
    this.mixed = false;
    DomUtils.clearChildren(this.$root);
    DomUtils.clearChildren(this.$head);
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: CheckboxList.Props): CheckboxList {
    return CheckboxList.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --checkbox-list-gap: 2px;
        display: block;
        width: 100%;
      }

      #head {
        padding-bottom: 4px;
        margin-bottom: 4px;
        border-bottom: 1px solid var(--divider);
      }

      #head[hidden] {
        display: none;
      }

      /* The mixed state's mark: a dash over the box, drawn on the host so it
         needs nothing from the checkbox's own shadow. */
      #head std-checkbox-cell[mixed] {
        position: relative;
      }

      #head std-checkbox-cell[mixed]::after {
        content: "";
        position: absolute;
        left: 16px;
        top: 50%;
        width: 8px;
        height: 2px;
        transform: translate(0, -50%);
        background: var(--text-pri);
        pointer-events: none;
      }

      #root {
        display: flex;
        flex-direction: column;
        gap: var(--checkbox-list-gap);
      }
    `,
  ];

  static $html = html`<div id="head" hidden></div><div id="root"></div>`;
}

export namespace CheckboxList {
  export type Item = { id: string; title: string; subtitle: Option<string>; disabled: boolean };
  export type Props = {
    items: Item[];
    values: string[];
    onChange: (values: string[]) => void;
    /** Label for a select-all header; `null` omits it. */
    selectAll: Option<string>;
    /** The group's accessible name. */
    label: string;
  };
}
