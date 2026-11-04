import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { FractalNoise } from "./fractal-noise";

const SVG_NS = "http://www.w3.org/2000/svg";

@component({ name: "std-fractal-noise-field" })
export class FractalNoiseField extends LonaWebComponent {
  private $svg: SVGSVGElement = this.hydrate("svg");
  private props: Option<FractalNoiseField.Props> = null;
  private lastRenderKey: Option<string> = null;

  onSizeChange: Option<(s: Size) => void> = (size: Size) => {
    this.renderForSize(size);
  };

  static makeWith(props: FractalNoiseField.Props): FractalNoiseField {
    return (FractalNoiseField.make() as FractalNoiseField).bind(props);
  }

  bind(props: FractalNoiseField.Props): this {
    this.props = props;
    this.lastRenderKey = null;
    this.renderForSize(this.currentSize(props.config.size));
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.props) this.renderForSize(this.currentSize(this.props.config.size));
  }

  private currentSize(fallback: FractalNoise.RenderSize): FractalNoise.RenderSize {
    return {
      width: this.offsetWidth > 0 ? this.offsetWidth : fallback.width,
      height: this.offsetHeight > 0 ? this.offsetHeight : fallback.height,
    };
  }

  private renderForSize(size: FractalNoise.RenderSize): void {
    if (!this.props || size.width <= 0 || size.height <= 0) return;

    const renderSize = FractalNoise.normalizeSize(size);
    const config = { ...this.props.config, size: renderSize };
    const renderKey = [
      config.seed,
      `${renderSize.width}x${renderSize.height}`,
      this.props.strategies.growth.name,
      this.props.strategies.split.name,
      this.props.strategies.layout.name,
      this.props.strategies.outline.name,
      config.minRadiusPx,
      config.maxRadiusPx,
      config.birthBandPx,
      config.growthExponent,
      config.maxDepth,
      config.maxShapeCount,
      config.shapePoints,
      config.jitter,
      this.props.debug.showOutlines,
      this.props.debug.showIds,
      this.props.debug.showBounds,
      this.props.debug.lifecycleOpacity,
    ].join(":");
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;

    const output = FractalNoise.generate(config, this.props.strategies);
    this.renderOutput(output, this.props.debug);
    this.props.onRender(output);
  }

  private renderOutput(
    output: FractalNoise.Output,
    debug: FractalNoiseField.DebugOptions,
  ): void {
    this.clearSvg();
    this.$svg.setAttribute("viewBox", `0 0 ${output.size.width} ${output.size.height}`);
    this.$svg.setAttribute("width", String(output.size.width));
    this.$svg.setAttribute("height", String(output.size.height));

    const $field = document.createElementNS(SVG_NS, "g");
    $field.setAttribute("class", "field");
    this.$svg.appendChild($field);

    for (const node of output.nodes) {
      const $path = document.createElementNS(SVG_NS, "path");
      $path.setAttribute("d", node.d);
      $path.setAttribute("class", `blob blob-${node.lifecycle}`);
      $path.setAttribute("data-node-id", node.id);
      $path.setAttribute("data-depth", String(node.depth));
      $path.setAttribute(
        "opacity",
        String(debug.lifecycleOpacity ? node.opacity : 1),
      );
      $field.appendChild($path);

      if (debug.showBounds) {
        const $bounds = document.createElementNS(SVG_NS, "rect");
        $bounds.setAttribute("class", "bounds");
        $bounds.setAttribute("x", String(node.bounds.minX));
        $bounds.setAttribute("y", String(node.bounds.minY));
        $bounds.setAttribute("width", String(node.bounds.maxX - node.bounds.minX));
        $bounds.setAttribute("height", String(node.bounds.maxY - node.bounds.minY));
        $field.appendChild($bounds);
      }

      if (debug.showIds) {
        const $label = document.createElementNS(SVG_NS, "text");
        $label.setAttribute("class", "node-label");
        $label.setAttribute("x", String(node.center.x));
        $label.setAttribute("y", String(node.center.y));
        $label.textContent = node.id;
        $field.appendChild($label);
      }
    }

    this.toggleAttribute("show-outlines", debug.showOutlines);
  }

  private clearSvg(): void {
    while (this.$svg.firstChild) {
      this.$svg.firstChild.remove();
    }
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
        overflow: hidden;
        color: var(--text-sec);
      }

      #svg {
        display: block;
        width: 100%;
        height: 100%;
        background: color-mix(in srgb, var(--bg) 96%, var(--text-pri) 4%);
      }

      .blob {
        fill: color-mix(in srgb, var(--blue) 18%, var(--bg) 82%);
        stroke: transparent;
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
        transition: opacity 0.3s ease;
      }

      :host([show-outlines]) .blob {
        stroke: color-mix(in srgb, var(--blue) 72%, var(--text-pri) 28%);
      }

      .blob-birthing-parent {
        fill: color-mix(in srgb, var(--orange) 20%, var(--bg) 80%);
      }

      .blob-birthing-child {
        fill: color-mix(in srgb, var(--teal) 24%, var(--bg) 76%);
      }

      .bounds {
        fill: transparent;
        stroke: color-mix(in srgb, var(--red) 66%, transparent);
        stroke-width: 1;
        stroke-dasharray: 4 3;
        vector-effect: non-scaling-stroke;
      }

      .node-label {
        fill: var(--text-ter);
        text-anchor: middle;
        dominant-baseline: middle;
        font-size: 9px;
        pointer-events: none;
        user-select: none;
      }
    `,
  ];

  static $html = html`<svg id="svg" role="img"></svg>`;
}

export namespace FractalNoiseField {
  export type DebugOptions = {
    showOutlines: boolean;
    showIds: boolean;
    showBounds: boolean;
    lifecycleOpacity: boolean;
  };

  export type Props = {
    config: FractalNoise.CommonConfig;
    strategies: FractalNoise.StrategyBundle;
    debug: DebugOptions;
    onRender: (output: FractalNoise.Output) => void;
  };
}
