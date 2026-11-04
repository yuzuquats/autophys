import "../controls/slider";
import "./input-layout";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { ThickSlider } from "../controls/slider";
import { InputLayout } from "./input-layout";

@component({
  name: "std-slider-input",
})
export class SliderInput extends LonaWebComponent {
  private $layout: InputLayout = this.hydrate("layout");
  private $slider: ThickSlider = this.hydrate("slider");

  onChange: Option<EmptyFunction>;

  get value(): number {
    return this.$slider.value;
  }

  bind(props: SliderInput.Props): this {
    const min = props.min ?? 0;
    const max = props.max ?? 100;
    const value = props.value ?? min;
    const snap = SliderInput.snapValues(min, max, props.step);
    if (!Number.isFinite(value)) throw new RangeError("SliderInput requires a finite value");
    // Validate before replacing the current layout or slider binding.
    // Layout props
    this.$layout.bind({
      label: props.label,
      description: props.description,
      caption: props.caption,
      required: props.required,
    });

    // Slider props

    this.$slider.bind({
      bounds: { start: min, end: max },
      value: value,
      snap: snap,
      renderSnaps: snap != null && snap.length <= 20,
      renderLastSnap: true,
    });

    this.$slider.onProgressChanged = () => this.onChange?.();

    return this;
  }

  /** Discrete snapping supports at most 1024 representably distinct values.
   * Denser ranges must use continuous input or a coarser explicit step. */
  static snapValues(min: number, max: number, step: Option<number>): Option<number[]> {
    const span = max - min;
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(span) || span <= 0) {
      throw new RangeError("SliderInput requires finite increasing bounds");
    }
    if (step == null) return null;
    const count = Math.floor(span / step) + 1;
    if (!Number.isFinite(step) || step <= 0 || min + step <= min || max - step >= max ||
      !Number.isSafeInteger(count) || count > 1024) {
      throw new RangeError("SliderInput step must progress and produce at most 1024 snaps");
    }
    const snap: number[] = [];
    for (let index = 0; index < count; index++) {
      const value = min + index * step;
      if (!Number.isFinite(value) || (index > 0 && value <= snap[index - 1])) {
        throw new RangeError("SliderInput snaps must be finite and distinct");
      }
      if (value <= max) snap.push(value);
    }
    return snap;
  }

  onRecycle(): void {
    this.onChange = null;
    this.$slider.onProgressChanged = () => {};
    super.onRecycle();
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
      }

      #slider {
        width: 100%;
        box-shadow: var(--box-shadow-light);
        --slider-track-height: 38px;
        --slider-progress-bg: var(--bg-surface-light);
        display: block;
        border-radius: 8px;
      }
    `,
  ];

  static $html = html`
    <std-input-layout id="layout">
      <std-thick-slider id="slider"></std-thick-slider>
    </std-input-layout>
  `;
}

export namespace SliderInput {
  export type Props = {
    label?: Option<string>;
    description?: Option<string>;
    caption?: Option<string>;
    required?: Option<boolean>;
    value?: Option<number>;
    min?: Option<number>;
    max?: Option<number>;
    step?: Option<number>;
  };
}
