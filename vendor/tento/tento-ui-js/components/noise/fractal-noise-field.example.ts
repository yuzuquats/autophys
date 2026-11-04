import "./fractal-noise-field";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Storybook } from "../../ui/storybook";
import { FractalNoise } from "./fractal-noise";
import type { FractalNoiseField } from "./fractal-noise-field";

type PresetId =
  | "smoothFieldFill"
  | "parentFootprintFill"
  | "largeIslandField"
  | "variedFieldFill";

type PreviewDefaults = {
  width: number;
  height: number;
  maxRadius: number;
  splitArity: number;
  growth: number;
  birthBand: number;
  jitter: number;
  retention: number;
};

@component({ name: "dev-fractal-noise-storybook-preview" })
class FractalNoiseStorybookPreview extends LonaWebComponent {
  private $field: FractalNoiseField = this.hydrate("field");
  private $frame: HTMLElement = this.$("frame");
  private $handle: HTMLElement = this.$("handle");
  private $status: HTMLElement = this.$("status");
  private $seed: HTMLInputElement = this.$("seed") as HTMLInputElement;
  private $preset: HTMLSelectElement = this.$("preset") as HTMLSelectElement;
  private $maxRadius: HTMLInputElement = this.$("max-radius") as HTMLInputElement;
  private $splitArity: HTMLInputElement = this.$("split-arity") as HTMLInputElement;
  private $growth: HTMLInputElement = this.$("growth") as HTMLInputElement;
  private $birthBand: HTMLInputElement = this.$("birth-band") as HTMLInputElement;
  private $jitter: HTMLInputElement = this.$("jitter") as HTMLInputElement;
  private $retention: HTMLInputElement = this.$("retention") as HTMLInputElement;
  private $outlines: HTMLInputElement = this.$("outlines") as HTMLInputElement;
  private $ids: HTMLInputElement = this.$("ids") as HTMLInputElement;
  private $bounds: HTMLInputElement = this.$("bounds") as HTMLInputElement;
  private $opacity: HTMLInputElement = this.$("opacity") as HTMLInputElement;

  private width = 420;
  private height = 300;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private startWidth = 0;
  private startHeight = 0;

  static makeWith(preset: PresetId): FractalNoiseStorybookPreview {
    return (FractalNoiseStorybookPreview.make() as FractalNoiseStorybookPreview)
      .bind(preset);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.bindInputs();
    this.$handle.addEventListener("pointerdown", this.handlePointerDown);
    this.$handle.addEventListener("pointermove", this.handlePointerMove);
    this.$handle.addEventListener("pointerup", this.handlePointerUp);
    this.$handle.addEventListener("pointercancel", this.handlePointerUp);
    this.render();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unbindInputs();
    this.$handle.removeEventListener("pointerdown", this.handlePointerDown);
    this.$handle.removeEventListener("pointermove", this.handlePointerMove);
    this.$handle.removeEventListener("pointerup", this.handlePointerUp);
    this.$handle.removeEventListener("pointercancel", this.handlePointerUp);
  }

  bind(preset: PresetId): this {
    this.$preset.value = preset;
    this.applyDefaults(this.presetDefaults(preset));
    this.render();
    return this;
  }

  private bindInputs(): void {
    for (const $input of this.controlElements()) {
      $input.addEventListener("input", this.handleInput);
      $input.addEventListener("change", this.handleInput);
    }
  }

  private unbindInputs(): void {
    for (const $input of this.controlElements()) {
      $input.removeEventListener("input", this.handleInput);
      $input.removeEventListener("change", this.handleInput);
    }
  }

  private controlElements(): Array<HTMLInputElement | HTMLSelectElement> {
    return [
      this.$seed,
      this.$preset,
      this.$maxRadius,
      this.$splitArity,
      this.$growth,
      this.$birthBand,
      this.$jitter,
      this.$retention,
      this.$outlines,
      this.$ids,
      this.$bounds,
      this.$opacity,
    ];
  }

  private handleInput = (): void => {
    this.render();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    this.isDragging = true;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.startWidth = this.width;
    this.startHeight = this.height;
    this.$handle.setPointerCapture(event.pointerId);
    this.$handle.style.background = "var(--blue-dimmed)";
    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.isDragging) return;

    this.width = Math.max(180, this.startWidth + event.clientX - this.dragStartX);
    this.height = Math.max(160, this.startHeight + event.clientY - this.dragStartY);
    this.render();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.isDragging) return;

    this.isDragging = false;
    if (this.$handle.hasPointerCapture(event.pointerId)) {
      this.$handle.releasePointerCapture(event.pointerId);
    }
    this.$handle.style.background = "var(--blue)";
  };

  private render(): void {
    this.$frame.style.width = `${this.width}px`;
    this.$frame.style.height = `${this.height}px`;
    this.$field.bind({
      config: this.config(),
      strategies: this.strategies(),
      debug: this.debug(),
      onRender: (output) => this.renderStatus(output),
    });
    this.updateControlLabels();
  }

  private config(): FractalNoise.CommonConfig {
    const maxRadius = this.numberValue(this.$maxRadius);
    return {
      seed: Math.round(this.numberValue(this.$seed)),
      size: { width: this.width, height: this.height },
      minRadiusPx: Math.max(3, maxRadius * 0.07),
      maxRadiusPx: maxRadius,
      birthBandPx: this.numberValue(this.$birthBand),
      growthExponent: this.numberValue(this.$growth),
      maxDepth: 6,
      maxShapeCount: 280,
      shapePoints: 28,
      jitter: this.numberValue(this.$jitter),
    };
  }

  private strategies(): FractalNoise.StrategyBundle {
    const options: FractalNoise.PresetOptions = {
      ...FractalNoise.Presets.DEFAULT_OPTIONS,
      splitArity: Math.round(this.numberValue(this.$splitArity)),
      areaRetention: this.numberValue(this.$retention),
    };

    switch (this.$preset.value as PresetId) {
      case "parentFootprintFill":
        return FractalNoise.Presets.parentFootprintFill(options);
      case "largeIslandField":
        return FractalNoise.Presets.largeIslandField(options);
      case "variedFieldFill":
        return FractalNoise.Presets.variedFieldFill(options);
      case "smoothFieldFill":
        return FractalNoise.Presets.smoothFieldFill(options);
    }
  }

  private applyDefaults(defaults: PreviewDefaults): void {
    this.width = defaults.width;
    this.height = defaults.height;
    this.$maxRadius.value = String(defaults.maxRadius);
    this.$splitArity.value = String(defaults.splitArity);
    this.$growth.value = String(defaults.growth);
    this.$birthBand.value = String(defaults.birthBand);
    this.$jitter.value = String(defaults.jitter);
    this.$retention.value = String(defaults.retention);
  }

  private presetDefaults(preset: PresetId): PreviewDefaults {
    switch (preset) {
      case "parentFootprintFill":
        return {
          width: 560,
          height: 360,
          maxRadius: 82,
          splitArity: 3,
          growth: 1.08,
          birthBand: 16,
          jitter: 0.18,
          retention: 1.18,
        };
      case "largeIslandField":
        return {
          width: 560,
          height: 360,
          maxRadius: 96,
          splitArity: 2,
          growth: 1.02,
          birthBand: 18,
          jitter: 0.16,
          retention: 1.30,
        };
      case "variedFieldFill":
        return {
          width: 560,
          height: 360,
          maxRadius: 78,
          splitArity: 3,
          growth: 1.14,
          birthBand: 14,
          jitter: 0.28,
          retention: 1.26,
        };
      case "smoothFieldFill":
        return {
          width: 560,
          height: 360,
          maxRadius: 86,
          splitArity: 3,
          growth: 1.10,
          birthBand: 16,
          jitter: 0.20,
          retention: 1.28,
        };
    }
  }

  private debug(): FractalNoiseField.DebugOptions {
    return {
      showOutlines: this.$outlines.checked,
      showIds: this.$ids.checked,
      showBounds: this.$bounds.checked,
      lifecycleOpacity: this.$opacity.checked,
    };
  }

  private renderStatus(output: FractalNoise.Output): void {
    this.$status.textContent = [
      `${output.size.width} x ${output.size.height}`,
      `${output.nodes.length} shapes`,
      `depth ${output.maxDepth}`,
      this.$preset.value,
      output.capped ? "capped" : "within cap",
    ].join(" / ");
  }

  private updateControlLabels(): void {
    this.$("max-radius-value").textContent = `${this.$maxRadius.value}px`;
    this.$("split-arity-value").textContent = this.$splitArity.value;
    this.$("growth-value").textContent = this.$growth.value;
    this.$("birth-band-value").textContent = `${this.$birthBand.value}px`;
    this.$("jitter-value").textContent = this.$jitter.value;
    this.$("retention-value").textContent = this.$retention.value;
  }

  private numberValue($input: HTMLInputElement): number {
    const value = Number($input.value);
    return Number.isFinite(value) ? value : 0;
  }

  static $styles = [
    css`
      :host {
        display: grid;
        gap: 18px;
        width: 100%;
        min-width: 0;
        padding: 16px;
        box-sizing: border-box;
      }

      #stage {
        min-height: 420px;
        display: grid;
        place-items: center;
        padding: 26px;
        border-radius: 8px;
        border: 1px solid var(--divider);
        background:
          linear-gradient(
            90deg,
            color-mix(in srgb, var(--divider) 48%, transparent) 1px,
            transparent 1px
          ),
          linear-gradient(
            color-mix(in srgb, var(--divider) 48%, transparent) 1px,
            transparent 1px
          ),
          color-mix(in srgb, var(--bg) 94%, var(--text-pri) 6%);
        background-size: 24px 24px;
      }

      #frame {
        position: relative;
        overflow: hidden;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--divider) 72%, transparent);
        box-shadow: 0 16px 34px color-mix(in srgb, var(--text-pri) 12%, transparent);
        background: var(--bg);
      }

      #field {
        display: block;
        width: 100%;
        height: 100%;
      }

      #handle {
        position: absolute;
        right: -7px;
        bottom: -7px;
        width: 14px;
        height: 14px;
        border-radius: 999px;
        background: var(--blue);
        cursor: nwse-resize;
        box-shadow: 0 2px 8px color-mix(in srgb, var(--text-pri) 26%, transparent);
        touch-action: none;
      }

      #status {
        color: var(--text-sec);
        --font-size: var(--text-10px);
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      #controls {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px 18px;
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--text-sec);
      }

      .control-label {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--text-sec);
        font-weight: 600;
        --font-size: var(--text-9px);
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      input,
      select {
        min-width: 0;
        color: var(--text-pri);
        background: var(--bg);
        border: 1px solid var(--divider);
        border-radius: 8px;
        padding: 7px 9px;
      }

      input[type="range"] {
        padding: 0;
      }

      .toggles {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        gap: 10px 16px;
        align-items: center;
      }

      .toggle {
        display: flex;
        grid-template-columns: none;
        grid-auto-flow: column;
        align-items: center;
        gap: 7px;
        color: var(--text-sec);
        --font-size: var(--text-9px);
      }

      @media (max-width: 768px) {
        #controls {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];

  static $html = html`
    <div id="stage">
      <div id="frame">
        <std-fractal-noise-field id="field"></std-fractal-noise-field>
        <div id="handle"></div>
      </div>
    </div>
    <p id="status"></p>
    <div id="controls">
      <label>
        <p class="control-label"><span>Seed</span></p>
        <input id="seed" type="number" value="9001" />
      </label>
      <label>
        <p class="control-label"><span>Strategy bundle</span></p>
        <select id="preset">
          <option value="smoothFieldFill">smoothFieldFill</option>
          <option value="parentFootprintFill">parentFootprintFill</option>
          <option value="largeIslandField">largeIslandField</option>
          <option value="variedFieldFill">variedFieldFill</option>
        </select>
      </label>
      <label>
        <p class="control-label">
          <span>Max radius</span><span id="max-radius-value"></span>
        </p>
        <input id="max-radius" type="range" min="34" max="150" value="86" />
      </label>
      <label>
        <p class="control-label">
          <span>Split arity</span><span id="split-arity-value"></span>
        </p>
        <input id="split-arity" type="range" min="2" max="5" value="3" />
      </label>
      <label>
        <p class="control-label">
          <span>Growth exponent</span><span id="growth-value"></span>
        </p>
        <input id="growth" type="range" min="0.70" max="1.80" step="0.02" value="1.10" />
      </label>
      <label>
        <p class="control-label">
          <span>Birth band</span><span id="birth-band-value"></span>
        </p>
        <input id="birth-band" type="range" min="6" max="48" value="16" />
      </label>
      <label>
        <p class="control-label">
          <span>Jitter</span><span id="jitter-value"></span>
        </p>
        <input id="jitter" type="range" min="0" max="0.55" step="0.01" value="0.20" />
      </label>
      <label>
        <p class="control-label">
          <span>Area retention</span><span id="retention-value"></span>
        </p>
        <input id="retention" type="range" min="0.80" max="1.60" step="0.01" value="1.16" />
      </label>
      <div class="toggles">
        <label class="toggle"><input id="outlines" type="checkbox" checked /> outlines</label>
        <label class="toggle"><input id="ids" type="checkbox" /> ids</label>
        <label class="toggle"><input id="bounds" type="checkbox" /> bounds</label>
        <label class="toggle"><input id="opacity" type="checkbox" checked /> lifecycle opacity</label>
      </div>
    </div>
  `;
}

export class FractalNoiseFieldStoryBook extends Storybook.Default {
  title(): string {
    return "Fractal Noise Field";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Smooth Field Fill",
        render: () => FractalNoiseStorybookPreview.makeWith("smoothFieldFill"),
      },
      {
        title: "Parent Footprint Fill",
        render: () => FractalNoiseStorybookPreview.makeWith("parentFootprintFill"),
      },
      {
        title: "Large Island Field",
        render: () => FractalNoiseStorybookPreview.makeWith("largeIslandField"),
      },
      {
        title: "Varied Field Fill",
        render: () => FractalNoiseStorybookPreview.makeWith("variedFieldFill"),
      },
    ];
  }
}
