import "../button/button";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { Position } from "../../anchor-positioning-utils";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Button } from "../button/button";
import { ContextMenu } from "../context-menu";

// What does not fit becomes a menu. Nothing measured a row and folded its
// tail. This observes its own width, measures the children inside
// `$$.measure` so it never thrashes layout, hides trailing items that do not
// fit, and renders a "+N" `std-button` that opens a `ContextMenu` of the
// hidden labels. Items are rendered once per bind and only shown or hidden
// per measurement; the overflow button is the one node that comes and goes.
@component({ name: "std-overflow-list" })
export class OverflowList extends LonaWebComponent {
  private $row: HTMLElement = this.$("row");
  private $items: HTMLElement = this.$("items");
  private $more: Button = this.hydrate("more");
  private props: Option<OverflowList.Props>;
  private $rendered: HTMLElement[] = [];
  private overflowed: OverflowList.Item[] = [];
  private layoutGeneration = 0;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$more, { onClick: () => this.openMenu() });
    this.onSizeChange = () => this.layout();
  }

  bind(props: OverflowList.Props): this {
    this.props = props;
    this.overflowed = [];
    this.$more.hidden = true;
    // Only the items container is cleared: `clearChildren` returns pooled
    // children to their pools, which would strip the overflow button's own
    // attributes if it lived in the same container.
    DomUtils.clearChildren(this.$items);
    this.$rendered = props.items.map((item) => {
      const $el = item.$render();
      $el.dataset.overflowId = item.id;
      this.$items.appendChild($el);
      return $el;
    });
    this.layout();
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.layout();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.layoutGeneration++;
  }

  private layout(): void {
    const generation = ++this.layoutGeneration;
    if (!this.isConnected || this.props == null) return;
    const ownsLayout = () => generation === this.layoutGeneration && this.isConnected && this.props != null;
    $$.measure(() => {
      if (!ownsLayout()) return;
      const available = this.$row.getBoundingClientRect().width;
      // A detached or display:none row has no usable geometry. Its next
      // connection or ResizeObserver notification will try again.
      if (available <= 0 || this.$row.getClientRects().length === 0) return;
      for (const $el of this.$rendered) $el.hidden = false;
      const widths = this.$rendered.map(($el) => $el.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(this.$row).columnGap) || 0;
      const moreWidth = this.$more.getBoundingClientRect().width || 48;
      $$.mutate(() => {
        if (!ownsLayout()) return;
        this.apply(widths, available, gap, moreWidth);
      });
    });
  }

  private apply(widths: number[], available: number, gap: number, moreWidth: number): void {
    const props = this.props;
    if (props == null) return;
    let cut = this.$rendered.length;
    const totalWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
    // Reserve a menu only when the complete row actually needs one.
    if (totalWidth > available) {
      let used = 0;
      for (let i = 0; i < this.$rendered.length; i++) {
        const w = widths[i] + (i > 0 ? gap : 0);
        const reserve = i < this.$rendered.length - 1 ? gap + moreWidth : 0;
        if (used + w + reserve > available && i > 0) {
          cut = i;
          break;
        }
        used += w;
      }
    }
    this.overflowed = props.items.slice(cut);
    this.$rendered.forEach(($el, i) => { $el.hidden = i >= cut; });
    const n = this.overflowed.length;
    this.$more.hidden = n === 0;
    this.$more.textContent = props.overflowLabel?.(n) ?? `+${n}`;
    this.$more.setAttribute("aria-label", `${n} more`);
    this.$more.setAttribute("aria-haspopup", "menu");
  }

  private openMenu(): void {
    const b = ContextMenu.builder();
    for (const item of this.overflowed) {
      b.cellRow(item.label, null, item.onSelect == null ? null : () => item.onSelect?.());
    }
    b.buildAndReveal(this.$more, { position: Position.BOTTOM_LEFT_X });
  }

  onRecycle(): void {
    super.onRecycle();
    this.layoutGeneration++;
    this.props = null;
    this.$rendered = [];
    this.overflowed = [];
    DomUtils.clearChildren(this.$items);
    this.$more.hidden = true;
  }

  static makeWith(props: OverflowList.Props): OverflowList {
    return OverflowList.make().bind(props);
  }

  static $styles = [
    Button.$style,
    css`
      :host {
        --overflow-list-gap: 6px;
        display: block;
        width: 100%;
        min-width: 0;
      }

      #row {
        display: flex;
        align-items: center;
        gap: var(--overflow-list-gap);
        width: 100%;
        overflow: hidden;
        white-space: nowrap;
      }

      #items {
        display: contents;
      }

      #items > [hidden] {
        display: none;
      }

      #more {
        flex: none;
      }
    `,
  ];

  static $html = html`<div id="row"><span id="items"></span><std-button id="more" secondary hidden></std-button></div>`;
}

export namespace OverflowList {
  export type Item = {
    id: string;
    $render: () => HTMLElement;
    /** The text the menu shows for a hidden item. */
    label: string;
    onSelect: Option<EmptyFunction>;
  };
  export type Props = {
    items: Item[];
    overflowLabel: Option<(n: number) => string>;
  };
}
