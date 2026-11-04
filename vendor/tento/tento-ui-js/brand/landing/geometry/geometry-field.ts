import { html, LonaWebComponent } from "../../../component";
import { component } from "../../../component-decorators";
import { css } from "../../../component-styles";
import { GeometrySource } from "./geometry-source";
import { GeometryWash } from "./wash-render";

const SVG_NS = "http://www.w3.org/2000/svg";

// The colored/wash fill: a FIXED, small adjacent-hue palette reused across ALL blobs, so a dense
// field stays cohesive instead of going rainbow (shared with the wash gallery).
const COLORED_PALETTE = GeometryWash.PALETTES.cool;
const COLORED_STROKE = "rgba(15, 23, 42, 0.22)";

// Draws a `GeometrySource`'s blobs and RE-GENERATES them whenever its own box resizes (via
// `onSizeChange` + the base ResizeObserver) — never `transform: scale`. So enlarging the element
// grows the blob COUNT while each blob keeps its absolute size. In "wash" mode it renders the
// same source through the real `GradientSplat` wash filter, so the decoupled geometry produces
// the actual resizable gradient.
@component({ name: "std-geometry-field" })
export class GeometryField extends LonaWebComponent {
  private $svg: SVGSVGElement = this.hydrate("svg");
  private $wash: HTMLElement = this.$("wash");
  private source: Option<GeometrySource> = null;
  private lastRenderKey: Option<string> = null;
  private mode: GeometryField.RenderMode = "geometry";
  private washBlurFrac = GeometryWash.DEFAULT.blurFrac;
  private washSharpen = GeometryWash.DEFAULT.sharpenAmount;
  onRender: Option<(stats: GeometryField.Stats) => void> = null;

  // Switch render mode and redraw at the current size.
  setMode(mode: GeometryField.RenderMode): void {
    this.mode = mode;
    this.lastRenderKey = null;
    this.renderForSize(this.currentSize());
  }

  // Wash blur amount (softness = blobSize · frac) — the blur↔sharpness knob. Render-only, so it
  // doesn't rebuild the geometry; lower = crisper edges (useful as the field fans out).
  setWashBlur(frac: number): void {
    this.washBlurFrac = frac;
    this.lastRenderKey = null;
    this.renderForSize(this.currentSize());
  }

  // How much of the wash resolves SHARP (0 = uniformly soft, ↑ = more crisp patches). Patches are
  // sub-blob, so raising this sharpens PART of each blob, not the whole thing. Render-only.
  setWashSharpen(amount: number): void {
    this.washSharpen = amount;
    this.lastRenderKey = null;
    this.renderForSize(this.currentSize());
  }

  onSizeChange: Option<(s: Size) => void> = (size: Size) => {
    this.renderForSize({ width: size.width, height: size.height });
  };

  static makeWith(source: GeometrySource): GeometryField {
    return (GeometryField.make() as GeometryField).bind(source);
  }

  bind(source: GeometrySource): this {
    this.source = source;
    this.lastRenderKey = null;
    this.renderForSize(this.currentSize());
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.source) this.renderForSize(this.currentSize());
  }

  private currentSize(): GeometrySource.Size {
    return { width: this.offsetWidth, height: this.offsetHeight };
  }

  private renderForSize(size: GeometrySource.Size): void {
    if (!this.source || size.width <= 0 || size.height <= 0) return;
    const width = Math.round(size.width);
    const height = Math.round(size.height);
    const key = `${this.source.name}:${this.mode}:${width}x${height}`;
    if (key === this.lastRenderKey) return;
    this.lastRenderKey = key;

    const renderSize: GeometrySource.Size = { width, height };
    if (this.mode === "wash") {
      this.renderWash(renderSize);
    } else {
      this.renderFlat(renderSize);
    }
  }

  // Flat geometry (mono or per-blob color) as inline SVG paths.
  private renderFlat(renderSize: GeometrySource.Size): void {
    const shapes = this.source!.shapesFor(renderSize, 0);
    this.$wash.style.display = "none";
    this.$wash.style.backgroundImage = "";
    this.$svg.style.display = "block";

    while (this.$svg.firstChild) this.$svg.firstChild.remove();
    this.$svg.setAttribute("viewBox", `0 0 ${renderSize.width} ${renderSize.height}`);
    this.$svg.setAttribute("width", String(renderSize.width));
    this.$svg.setAttribute("height", String(renderSize.height));
    shapes.forEach((shape, i) => {
      const $path = document.createElementNS(SVG_NS, "path");
      $path.setAttribute("d", shape.d);
      $path.setAttribute("class", "blob");
      if (this.mode === "colored") {
        $path.style.fill = COLORED_PALETTE[i % COLORED_PALETTE.length];
        $path.style.stroke = COLORED_STROKE;
      }
      this.$svg.appendChild($path);
    });

    this.reportStats(shapes, renderSize);
  }

  // The real wash, via the shared bridge — same renderer the "Gradient Splat — new" gallery uses,
  // with the live blur/sharpen knobs. Painted as a cover background; stats from a pad-free probe
  // (same count/radius, only positions differ).
  private renderWash(renderSize: GeometrySource.Size): void {
    const background = GeometryWash.background(this.source!, renderSize, {
      ...GeometryWash.DEFAULT,
      blurFrac: this.washBlurFrac,
      sharpenAmount: this.washSharpen,
      colors: COLORED_PALETTE,
    });

    this.$svg.style.display = "none";
    while (this.$svg.firstChild) this.$svg.firstChild.remove();
    this.$wash.style.display = "block";
    this.$wash.style.backgroundImage = background;

    this.reportStats(this.source!.shapesFor(renderSize, 0), renderSize);
  }

  private reportStats(
    shapes: ReturnType<GeometrySource["shapesFor"]>,
    renderSize: GeometrySource.Size,
  ): void {
    this.onRender?.({
      count: shapes.length,
      meanRadius: GeometrySource.meanRadius(shapes),
      coverage: GeometrySource.coverage(shapes, renderSize),
      blobSizePx: this.source!.blobSizePx,
    });
  }

  static $styles = [
    css`
      :host {
        display: block;
        position: relative;
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

      /* Wash layer: the GradientSplat data-url painted edge-to-edge over the white field. */
      #wash {
        display: none;
        position: absolute;
        inset: 0;
        background-color: color-mix(in srgb, var(--bg) 96%, var(--text-pri) 4%);
        background-repeat: no-repeat;
        background-position: center;
        background-size: cover;
      }

      /* Flat translucent fill + hairline outline so each blob's size + overlap reads clearly. */
      .blob {
        fill: color-mix(in srgb, var(--blue) 22%, var(--bg) 78%);
        stroke: color-mix(in srgb, var(--blue) 60%, var(--text-pri) 40%);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
    `,
  ];

  static $html = html`
    <svg id="svg" role="img"></svg>
    <div id="wash"></div>
  `;
}

export namespace GeometryField {
  // How the field paints the source's blobs:
  //   geometry — flat mono outlines (read the size + overlap)
  //   colored  — flat per-blob hue cycle (read individual blobs)
  //   wash     — the REAL grainy-gradient wash, driven by this decoupled source (the hook-up:
  //              the resizable geometry now feeds the actual blur→goo→grain filter)
  export type RenderMode = "geometry" | "colored" | "wash";

  export type Stats = {
    count: number;
    meanRadius: number;
    coverage: number;
    blobSizePx: number;
  };
}
