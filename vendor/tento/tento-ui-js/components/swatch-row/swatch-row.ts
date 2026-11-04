import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { Div } from "../../component-builtin";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";

/**
 * `SwatchRow` (`std-swatch-row`) — a color-agnostic, data-driven row of color
 * squares. Each swatch takes any CSS `background` (a solid color or a gradient),
 * so it carries no theme/data-model dependency; callers supply the colors.
 *
 * Squares only — there is no visible label text. A swatch's optional `label`
 * maps to the square's `title` (hover tooltip / a11y), never to rendered text.
 *
 * Optionally interactive: pass `onSelect` to make the squares clickable (with a
 * selection ring on the active one) and `onHover` to live-preview on hover. The
 * ring is driven by `selectedIndex` and moves to the clicked square.
 *
 * A small reusable "accessory" element: it can sit in a card accessory slot, a
 * `ListItem.$accessory`, a sidebar CTA, etc. Square size, gap, and corner radius
 * are CSS custom properties (`--swatch-size`/`--swatch-gap`/`--swatch-radius`),
 * so consumers tune the look via styles rather than props.
 */
@component({ name: "std-swatch-row" })
export class SwatchRow extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");
  private $squares: HTMLElement[] = [];
  private selectedIndex: Option<number> = null;
  private onSelect: Option<(index: number) => void> = null;
  private onHover: Option<(index: Option<number>) => void> = null;
  private hoverBound = false;

  static makeWith(props: SwatchRow.Props): SwatchRow {
    return SwatchRow.make().bind(props);
  }

  bind(props: SwatchRow.Props): this {
    this.retireSquares();
    DomUtils.clearChildren(this.$root);
    this.$squares = [];
    this.selectedIndex = props.selectedIndex ?? null;
    this.onSelect = props.onSelect ?? null;
    this.onHover = props.onHover ?? null;

    const interactive = this.onSelect != null || this.onHover != null;
    this.toggleAttribute("interactive", interactive);

    for (let i = 0; i < props.swatches.length; i++) {
      const swatch = props.swatches[i];
      const $square = this.onSelect != null ? document.createElement("button") : Div.make();
      if ($square instanceof HTMLButtonElement) {
        $square.type = "button";
        $square.disabled = props.disabled ?? false;
        $square.setAttribute("aria-label", swatch.label ?? `Swatch ${i + 1}`);
      }
      $square.classList.add("swatch");
      $square.assignStyles({ background: swatch.background });
      // Label is a tooltip / a11y hint only — never rendered as visible text.
      if (swatch.label) {
        $square.title = swatch.label;
        $square.setAttribute("aria-label", swatch.label);
      }

      if (this.onSelect) {
        GESTURE_MANAGER.addPointerEvent($square, {
          onClick: () => { if ($square instanceof HTMLButtonElement && $square.disabled) return; this.select(i); },
        });
      }
      if ($square instanceof HTMLButtonElement) {
        // Keyboard activation generates one native click. Pointer selection stays
        // with GestureManager, so its later compatibility click is not duplicated.
        $square.addEventListener("click", event => { if (event.detail === 0 && !$square.disabled && this.$squares[i] === $square) this.select(i); });
      }
      if (this.onHover) {
        // Per-square enter previews that swatch; the row-level leave (bound once
        // below) restores. Per-square leave would flicker between neighbors.
        $square.addEventListener("pointerenter", () => { if (this.$squares[i] === $square) this.onHover?.(i); });
      }

      this.$squares.push($square);
      this.$root.appendChild($square);
    }

    this.applySelection();

    if (this.onHover && !this.hoverBound) {
      this.$root.addEventListener("pointerleave", () => this.onHover?.(null));
      this.hoverBound = true;
    }

    return this;
  }

  private select(index: number): void {
    this.selectedIndex = index;
    this.applySelection();
    this.onSelect?.(index);
  }

  private applySelection(): void {
    for (let i = 0; i < this.$squares.length; i++) {
      this.$squares[i].classList.toggle("selected", i === this.selectedIndex);
      if (this.$squares[i] instanceof HTMLButtonElement) {
        this.$squares[i].setAttribute("aria-pressed", String(i === this.selectedIndex));
      }
    }
  }

  private retireSquares(): void {
    for (const square of this.$squares) GESTURE_MANAGER.unregister(square);
  }

  onRecycle(): void {
    this.retireSquares();
    this.$squares = [];
    this.onSelect = null;
    this.onHover = null;
    this.selectedIndex = null;
    DomUtils.clearChildren(this.$root);
    super.onRecycle();
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
      }

      #root {
        align-items: center;
        flex-wrap: wrap;
        gap: var(--swatch-gap, 8px);
      }

      .swatch {
        border: 0;
        padding: 0;
        appearance: none;
        width: var(--swatch-size, 24px);
        height: var(--swatch-size, 24px);
        border-radius: var(--swatch-radius, 8px);
        flex-shrink: 0;
      }

      :host([interactive]) .swatch {
        cursor: pointer;
        transition: box-shadow 0.15s ease, transform 0.15s ease;
      }

      .swatch:focus-visible {
        outline: 2px solid var(--accent, #007aff);
        outline-offset: 5px;
      }

      .swatch.selected {
        box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--text-pri);
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root"></std-row>
  `;
}

export namespace SwatchRow {
  export type Swatch = { background: string; label?: Option<string> };
  export type Props = {
    swatches: Swatch[];
    disabled?: Option<boolean>;
    // When set, the square at this index shows the selection ring.
    selectedIndex?: Option<number>;
    // When set, squares are clickable; the ring moves to the clicked square and
    // `onSelect(index)` fires (commit).
    onSelect?: Option<(index: number) => void>;
    // When set, hovering a square fires `onHover(index)` (preview); leaving the
    // row fires `onHover(null)` (restore).
    onHover?: Option<(index: Option<number>) => void>;
  };
}
