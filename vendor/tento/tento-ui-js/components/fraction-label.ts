import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { $$ } from "@tento-ui/fastdom";

const ANGLE = Math.PI / 6; // 30 degrees from vertical
const SIN_ANGLE = Math.sin(ANGLE);
const COS_ANGLE = Math.cos(ANGLE);
const RENDER_OPTIONS: FractionLabel.RenderOptions = {
  yOffsetRatio: 0.1,
  gap: 2,
  lineLengthRatio: 0.25,
};

/**
 * Renders a fraction (like 11/13) in a diagonal layout.
 * Numbers are positioned with constant perpendicular distance from the slash.
 */
@component({
  name: "std-fraction-label",
})
export class FractionLabel extends LonaWebComponent {
  private $numbers: HTMLElement = this.$("numbers");
  private $numerator: HTMLElement = this.$("numerator");
  private $denominator: HTMLElement = this.$("denominator");
  private $line: SVGLineElement = this.$("line") as unknown as SVGLineElement;

  private fixedFontSize: Option<number>;
  private _lastNum: Option<string> = null;
  private _lastDen: Option<string> = null;
  private _lastWidth = 0;
  private _lastHeight = 0;
  private _lastFontSize: Option<number> = null;
  private measurementRevision = 0;
  private hasBound = false;
  private observedSize: Option<Size> = null;

  bind(numerator: string, denominator: string, fixedFontSize: Option<number>): this {
    // The memo keys on inputs alone: a zero-width instance (hidden sidebar,
    // pooled cell) must return here too, or every rebind re-pays the
    // measurement below. Text is already in the DOM, and the ResizeObserver
    // (onSizeChange) renders when the element actually gets a size.
    const sameInputs =
      this._lastNum === numerator &&
      this._lastDen === denominator &&
      this._lastFontSize === (fixedFontSize ?? null);
    if (sameInputs) return this;
    const firstBind = !this.hasBound;
    this.hasBound = true;
    const fontChanged = this._lastFontSize !== (fixedFontSize ?? null);
    this._lastNum = numerator;
    this._lastDen = denominator;
    this._lastFontSize = fixedFontSize ?? null;
    this.fixedFontSize = fixedFontSize;
    this.$numerator.textContent = numerator;
    this.$denominator.textContent = denominator;

    // Newly connected labels get an initial ResizeObserver delivery. Reading
    // their offsets during a column bind would force layout of the new column.
    if (firstBind) {
      if (this.observedSize) this.render(this.observedSize, RENDER_OPTIONS);
      return this;
    }

    // Intrinsic grid tracks absorb text-width changes without JS geometry.
    // The observer remains responsible for container-size changes, including
    // a hidden label returning to view after a text-only bind.
    if (!fontChanged) return this;
    // A font change while hidden must repaint even at the former dimensions.
    this._lastWidth = 0;
    this._lastHeight = 0;
    const revision = ++this.measurementRevision;

    // Measure in the read phase: bind() is routinely called from write-phase
    // contexts, where a synchronous offsetWidth is a forced layout of the
    // whole dirty document. The label fades in over its own transition, so
    // the one-frame positioning latency is invisible.
    $$.measure(() => {
      if (revision !== this.measurementRevision) return;
      const width = this.offsetWidth;
      const height = this.offsetHeight;
      if (width <= 0 || height <= 0) return;
      $$.mutate(() => {
        if (revision !== this.measurementRevision) return;
        this.render({ width, height }, RENDER_OPTIONS);
      });
    });
    return this;
  }

  onSizeChange = (size: Size) => {
    // Even a zero-size or unchanged observation retires older sampled geometry.
    this.measurementRevision++;
    this.observedSize = { width: size.width, height: size.height };
    if (!this.hasBound) return;
    if (size.width === this._lastWidth && size.height === this._lastHeight) {
      return;
    }
    this.render(size, RENDER_OPTIONS);
  };

  disconnectedCallback(): void {
    this.measurementRevision++;
    this.observedSize = null;
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.measurementRevision++;
    this.hasBound = false;
    this.observedSize = null;
    this._lastNum = null;
    this._lastDen = null;
    this._lastWidth = 0;
    this._lastHeight = 0;
    this._lastFontSize = null;
    super.onRecycle();
  }

  private render(size: Size, options: FractionLabel.RenderOptions): void {
    const { width, height } = size;
    if (width <= 0 || height <= 0) return;
    this._lastNum = this.$numerator.textContent;
    this._lastDen = this.$denominator.textContent;
    this._lastWidth = width;
    this._lastHeight = height;
    this._lastFontSize = this.fixedFontSize ?? null;
    const { yOffsetRatio, gap, lineLengthRatio } = options;
    const minDim = Math.min(width, height);
    const fontSize =
      this.fixedFontSize ?? Math.max(6, Math.floor(minDim * 0.3));
    const centerX = width / 2;
    const centerY = height / 2;
    const lineLength = minDim * lineLengthRatio;
    const yOffsetFromCenter = yOffsetRatio * fontSize;
    const horizGap = gap / COS_ANGLE;
    const textOffsetX = horizGap - yOffsetFromCenter * SIN_ANGLE / COS_ANGLE;
    const textOffsetY = fontSize / 2 + yOffsetFromCenter;

    // Set font sizes and draw line immediately
    this.$numerator.style.fontSize = `${fontSize}px`;
    this.$denominator.style.fontSize = `${fontSize}px`;

    this.$line.setAttribute("x1", String(centerX + SIN_ANGLE * lineLength));
    this.$line.setAttribute("y1", String(centerY - COS_ANGLE * lineLength));
    this.$line.setAttribute("x2", String(centerX - SIN_ANGLE * lineLength));
    this.$line.setAttribute("y2", String(centerY + COS_ANGLE * lineLength));

    // Equal intrinsic tracks each take the wider text's width. Their centers
    // already supply +/- halfMax; only the slash gap and vertical offsets
    // remain. No text-width read or second write phase is needed. Keep this
    // signed offset out of CSS gap: large fonts can make it negative.
    this.$numbers.style.left = `${centerX}px`;
    this.$numbers.style.top = `${centerY}px`;
    this.$numerator.style.transform = `translate(${-textOffsetX}px, ${-textOffsetY}px)`;
    this.$denominator.style.transform = `translate(${textOffsetX}px, ${textOffsetY}px)`;
  }

  static $styles = [
    css`
      :host {
        display: block;
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }

      #numbers {
        position: absolute;
        top: 0;
        left: 0;
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        justify-items: center;
        align-items: center;
        width: max-content;
        transform: translate(-50%, -50%);
      }

      #numerator,
      #denominator {
        grid-row: 1;
        color: var(--label-color, var(--text-sec));
        line-height: 1;
        white-space: nowrap;
      }

      #numerator {
        grid-column: 1;
      }

      #denominator {
        grid-column: 2;
      }

      :host(:dir(rtl)) #numerator {
        grid-column: 2;
      }

      :host(:dir(rtl)) #denominator {
        grid-column: 1;
      }

      #svg {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }

      #line {
        stroke: var(--label-color, var(--text-ter));
        stroke-width: 1;
        stroke-linecap: round;
      }
    `,
  ];

  static $html = html`
    <div id="numbers">
      <div id="numerator"></div>
      <div id="denominator"></div>
    </div>
    <svg id="svg">
      <line id="line" />
    </svg>
  `;
}

export namespace FractionLabel {
  export interface RenderOptions {
    /**
     * Vertical offset from center as a multiple of fontSize.
     * Controls how far the numerator is above center and denominator is below center.
     * Example: 0.15 means 0.15 * fontSize from center.
     */
    yOffsetRatio: number;

    /**
     * Perpendicular distance in pixels from the slash line to the nearest
     * text edge. Converted to horizontal distance via `gap / cos(angle)`.
     */
    gap: number;

    /**
     * Length of the slash line as a ratio of the minimum container dimension.
     * The line extends this ratio * minDim in each direction from center.
     * Example: 0.35 means the line is 70% of minDim total length (35% each side).
     */
    lineLengthRatio: number;
  }

  export function makeWith(
    numerator: string,
    denominator: string,
    fixedFontSize?: number,
  ): FractionLabel {
    return FractionLabel.make().bind(numerator, denominator, fixedFontSize);
  }
}
