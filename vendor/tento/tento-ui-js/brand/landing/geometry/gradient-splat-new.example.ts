import { html, LonaWebComponent } from "../../../component";
import { component } from "../../../component-decorators";
import { css } from "../../../component-styles";
import { Storybook } from "../../../ui/storybook";
import { ClusterGrowthSource } from "./cluster-growth-source";
import { GeometryWash } from "./wash-render";

// "Gradient Splat — new": the wash driven by the decoupled, resizable cluster-growth geometry
// (the same renderer the Geometry Field's Wash mode uses), shown as a grid of PERMUTATIONS of the
// params — spread, size variance, size↔canvas, blur, sharpen, density, palette — so the looks can
// be compared side by side. Each tile re-generates at its render size (not transform-scaled).

const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 180;
// Render the SVG at N× the tile size and let `background-size: cover` downscale → a crisp,
// supersampled raster (the browser otherwise rasterizes the filter at the low box resolution).
const SUPERSAMPLE = 2;

type Variant = {
  label: string;
  caption: string; // the distinguishing params
  config: Partial<ClusterGrowthSource.Config>;
  wash: Partial<GeometryWash.Options>;
};

// Each variant overrides a few params off the defaults (+ a distinct seed so layouts differ).
const VARIANTS: readonly Variant[] = [
  { label: "Baseline", caption: "defaults · cool", config: { seed: 1337 }, wash: {} },
  {
    label: "Tight",
    caption: "spread 1.1 · warm",
    config: { seed: 2027, spread: 1.1 },
    wash: { colors: GeometryWash.PALETTES.warm },
  },
  {
    label: "Airy",
    caption: "spread 2.2 · violet",
    config: { seed: 3041, spread: 2.2 },
    wash: { colors: GeometryWash.PALETTES.violet },
  },
  {
    label: "Uniform size",
    caption: "variance 0.1 · meadow",
    config: { seed: 4051, sizeJitter: 0.1 },
    wash: { colors: GeometryWash.PALETTES.meadow },
  },
  {
    label: "High variance",
    caption: "variance 0.75 · rose",
    config: { seed: 5077, sizeJitter: 0.75 },
    wash: { colors: GeometryWash.PALETTES.rose },
  },
  {
    label: "Soft / dreamy",
    caption: "blur 0.45 · sharpen 0.1",
    config: { seed: 6089 },
    wash: { blurFrac: 0.45, sharpenAmount: 0.1 },
  },
  {
    label: "Crisp focus",
    caption: "blur 0.16 · sharpen 0.85 · warm",
    config: { seed: 7103 },
    wash: { blurFrac: 0.16, sharpenAmount: 0.85, colors: GeometryWash.PALETTES.warm },
  },
  {
    label: "Fine blobs",
    caption: "size 30 · violet",
    config: { seed: 8111, blobSizePx: 30 },
    wash: { colors: GeometryWash.PALETTES.violet },
  },
  {
    label: "Big blobs",
    caption: "size 72 · meadow",
    config: { seed: 9127, blobSizePx: 72 },
    wash: { colors: GeometryWash.PALETTES.meadow },
  },
  {
    label: "Scales w/ canvas",
    caption: "sizeScale 0.9 · rose",
    config: { seed: 10139, sizeScaleFactor: 0.9 },
    wash: { colors: GeometryWash.PALETTES.rose },
  },
  {
    label: "Dense",
    caption: "packing 0.7 · cool",
    config: { seed: 11149, packing: 0.7 },
    wash: {},
  },
  {
    label: "Sparse",
    caption: "packing 0.22 · warm",
    config: { seed: 12157, packing: 0.22 },
    wash: { colors: GeometryWash.PALETTES.warm },
  },
];

@component({ name: "std-gradient-splat-new-gallery" })
class GradientSplatNewGallery extends LonaWebComponent {
  static makeWith(): GradientSplatNewGallery {
    return (GradientSplatNewGallery.make() as GradientSplatNewGallery).bind();
  }

  bind(): this {
    this.$("grid").replaceChildren(...VARIANTS.map((variant) => this.tileFor(variant)));
    return this;
  }

  private tileFor(variant: Variant): HTMLElement {
    const size = {
      width: PREVIEW_WIDTH * SUPERSAMPLE,
      height: PREVIEW_HEIGHT * SUPERSAMPLE,
    };
    const source = ClusterGrowthSource.create({ ...ClusterGrowthSource.DEFAULT, ...variant.config });
    const washOptions: GeometryWash.Options = { ...GeometryWash.DEFAULT, ...variant.wash };

    const $wash = document.createElement("div");
    $wash.className = "wash";
    // Longhand `backgroundImage` ONLY — the `background` shorthand resets background-size/repeat.
    $wash.style.backgroundImage = GeometryWash.background(source, size, washOptions);

    const $preview = document.createElement("div");
    $preview.className = "preview";
    $preview.appendChild($wash);

    const $label = document.createElement("p");
    $label.className = "label";
    $label.textContent = variant.label;

    const $caption = document.createElement("p");
    $caption.className = "caption";
    $caption.textContent = variant.caption;

    const $tile = document.createElement("div");
    $tile.className = "tile";
    $tile.append($preview, $label, $caption);
    return $tile;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        min-width: 0;
      }

      /* Tile min-width mirrors PREVIEW_WIDTH (the css tag takes no interpolation). */
      #grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 16px;
        padding: 16px;
        box-sizing: border-box;
      }

      .tile {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }

      /* White card surface so the alpha blobs read as they do on the real card. */
      .preview {
        position: relative;
        width: 100%;
        height: 180px;
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid var(--divider);
        background: var(--bg);
        margin-bottom: 4px;
      }

      .wash {
        position: absolute;
        inset: 0;
        background-repeat: no-repeat;
        background-position: center;
        background-size: cover;
      }

      .label {
        color: var(--text-sec);
        --font-size: var(--text-10px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-weight: 600;
      }

      .caption {
        color: var(--text-ter);
        --font-size: var(--text-9px);
        --margin-top: 0px;
        --margin-bottom: 0px;
      }
    `,
  ];

  static $html = html`<div id="grid"></div>`;
}

export class GradientSplatNewStoryBook extends Storybook.Default {
  title(): string {
    return "Gradient Splat — new";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Geometry-source wash — permutations of the params",
        render: () => GradientSplatNewGallery.makeWith(),
      },
    ];
  }
}
