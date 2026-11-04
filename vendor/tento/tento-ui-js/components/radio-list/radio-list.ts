import "../radio-button-cell";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";
import { RadioButtonCell } from "../radio-button-cell";

// The radio cells, grouped, with the group's keyboard. `std-radio-button-cell`
// is a single row; every list of them was a `div` with no `radiogroup` and no
// arrow keys. This composes the cells under `role=radiogroup`, keeps `value`
// as a prop, and roves one tab stop: arrows move focus AND selection, which
// is the native radio contract the reader expects.
@component({ name: "std-radio-list" })
export class RadioList extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private props: Option<RadioList.Props>;
  private $cells: RadioButtonCell[] = [];
  private static seq = 0;
  private readonly name = `std-radio-list-${++RadioList.seq}`;

  constructor() {
    super();
    this.$root.addEventListener("keydown", this.onKeydown);
  }

  bind(props: RadioList.Props): this {
    this.props = props;
    this.setAttribute("role", "radiogroup");
    this.setAttribute("aria-label", props.label);
    DomUtils.clearChildren(this.$root);
    this.$cells = props.items.map((item) => {
      const $subtitle = item.subtitle == null ? undefined : Typography.small(item.subtitle);
      const $cell = RadioButtonCell.makeWith({
        title: item.title,
        options: {
          $subtitle,
          name: this.name,
          value: item.id,
          onChecked: () => this.choose(item.id),
        },
      });
      $cell.checked = item.id === props.value;
      $cell.toggleAttribute("disabled", item.disabled);
      this.$root.appendChild($cell);
      return $cell;
    });
    this.rove();
    return this;
  }

  private choose(id: string): void {
    const props = this.props;
    if (props == null || id === props.value) return;
    this.props = { ...props, value: id };
    this.$cells.forEach(($c, i) => { $c.checked = props.items[i].id === id; });
    this.rove();
    props.onChange(id);
  }

  /** The node that takes focus inside a cell. `std-radio-button` draws its
   * own control — no native input — and its focusable ring is the `#outer`
   * div one shadow root down. Reaching in is what the toolbar does for a
   * `std-button` too; it goes away when the radio button's own review fix
   * gives it a focus method. */
  private input($cell: RadioButtonCell): Option<HTMLElement> {
    return (
      $cell.shadowRoot?.querySelector("std-radio-button")?.shadowRoot?.querySelector<HTMLElement>("#outer") ?? null
    );
  }

  /** One tab stop: the checked item, else the first enabled one. */
  private rove(): void {
    const props = this.props;
    if (props == null) return;
    let stop = props.items.findIndex((it) => it.id === props.value && !it.disabled);
    if (stop < 0) stop = props.items.findIndex((it) => !it.disabled);
    this.$cells.forEach(($c, i) => {
      const $in = this.input($c);
      if ($in != null) $in.tabIndex = i === stop ? 0 : -1;
    });
  }

  private onKeydown = (e: KeyboardEvent): void => {
    const props = this.props;
    if (props == null) return;
    // The key lands on a node two shadow roots down; `closest()` cannot cross
    // a shadow boundary, so the cell host is found on the composed path.
    const $host = e.composedPath().find((n) => this.$cells.includes(n as RadioButtonCell)) as Option<RadioButtonCell>;
    const i = $host == null ? -1 : this.$cells.indexOf($host);
    if (i < 0) return;
    const n = this.$cells.length;
    const step = (from: number, dir: number): number => {
      let j = from;
      for (let k = 0; k < n; k++) {
        j = (j + dir + n) % n;
        if (!props.items[j].disabled) return j;
      }
      return from;
    };
    let next: Option<number> = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = step(i, 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = step(i, -1);
    else if (e.key === "Home") next = step(n - 1, 1);
    else if (e.key === "End") next = step(0, -1);
    if (next == null) return;
    e.preventDefault();
    this.choose(props.items[next].id);
    this.input(this.$cells[next])?.focus();
  };

  // `std-radio-button` writes `tabindex=0` on its ring in ITS connectedCallback,
  // which runs after `bind()` when the list is built before insertion — and
  // after this host's own callback, since descendants connect after their
  // parent. A microtask lands after the whole subtree has connected.
  connectedCallback(): void {
    super.connectedCallback();
    queueMicrotask(() => this.rove());
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$cells = [];
    DomUtils.clearChildren(this.$root);
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: RadioList.Props): RadioList {
    return RadioList.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --radio-list-gap: 2px;
        display: block;
        width: 100%;
      }

      #root {
        display: flex;
        flex-direction: column;
        gap: var(--radio-list-gap);
      }

      std-radio-button-cell[disabled] {
        opacity: 0.5;
        pointer-events: none;
      }
    `,
  ];

  static $html = html`<div id="root"></div>`;
}

export namespace RadioList {
  export type Item = { id: string; title: string; subtitle: Option<string>; disabled: boolean };
  export type Props = {
    items: Item[];
    value: Option<string>;
    onChange: (id: string) => void;
    /** The group's accessible name. */
    label: string;
  };
}
