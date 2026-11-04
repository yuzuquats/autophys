import "./chip";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Chip } from "./chip";

// A wrapping strip of `std-chip`s. Binding an empty list hides the row
// entirely, so a consumer can bind unconditionally instead of deciding whether
// the strip is worth rendering — an empty strip would otherwise leave a stray
// band of padding above whatever follows it.
@component({ name: "std-chip-row" })
export class ChipRow extends LonaWebComponent {
  private $chips: HTMLElement = this.$("chips");

  static makeWith(chips: Chip.ViewModel[]): ChipRow {
    return ChipRow.make().bind(chips);
  }

  bind(chips: Chip.ViewModel[]): this {
    DomUtils.clearChildren(this.$chips);
    for (const chip of chips) this.$chips.appendChild(Chip.makeWith(chip));
    this.hidden = chips.length === 0;
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.bind([]);
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      #chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--chip-row-gap, 4px);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<div id="chips"></div>`;
}
