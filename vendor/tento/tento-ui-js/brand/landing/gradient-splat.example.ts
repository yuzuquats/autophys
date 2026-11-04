import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Storybook } from "../../ui/storybook";
import { Switch } from "../../components/controls/switch";
import { GradientSplat } from "./gradient-splat";

// "Gradient Splat — current": a gallery of the live wash (`backgroundForSize`), one tile per
// palette, with a Geometry toggle to inspect the backing shapes (`geometryForSize`) instead.

const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 180;
// Render the SVG at N× the tile size and let `background-size: cover` downscale it → a crisp,
// supersampled raster (the browser otherwise rasterizes the filter at the low box resolution).
const SUPERSAMPLE = 2;

type GalleryMode = "splat" | "geometry";

@component({ name: "std-gradient-splat-gallery" })
class GradientSplatGallery extends LonaWebComponent {
  private mode: GalleryMode = "splat";

  static makeWith(): GradientSplatGallery {
    return (GradientSplatGallery.make() as GradientSplatGallery).bind();
  }

  bind(): this {
    this.$("toggle").replaceChildren(
      Switch.makeWith({
        checked: false,
        onChange: (checked) => {
          this.mode = checked ? "geometry" : "splat";
          this.renderGrid();
        },
      }),
    );
    this.renderGrid();
    return this;
  }

  private renderGrid(): void {
    this.$("grid").replaceChildren(
      ...GradientSplat.PALETTES.map((palette) => this.tileFor(palette)),
    );
  }

  private tileFor(palette: GradientSplat.Palette): HTMLElement {
    const size: GradientSplat.RenderSize = {
      width: PREVIEW_WIDTH * SUPERSAMPLE,
      height: PREVIEW_HEIGHT * SUPERSAMPLE,
    };
    const $wash = document.createElement("div");
    $wash.className = "wash";
    // Longhand `backgroundImage` ONLY — the `background` shorthand resets
    // background-size/repeat to initial and re-tiles the SVG.
    $wash.style.backgroundImage = this.mode === "geometry"
      ? palette.geometryForSize(size)
      : palette.backgroundForSize(size, 0);

    const $label = document.createElement("p");
    $label.className = "label";
    $label.textContent = palette.label;

    const $preview = document.createElement("div");
    $preview.className = "preview";
    $preview.appendChild($wash);

    const $tile = document.createElement("div");
    $tile.className = "tile";
    $tile.append($preview, $label);
    return $tile;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        min-width: 0;
      }

      #header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 16px 16px 0;
        color: var(--text-sec);
      }

      .header-label {
        --font-size: var(--text-10px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-weight: 600;
      }

      /* Tile min-width/height mirror PREVIEW_WIDTH/PREVIEW_HEIGHT (the css tag takes no
         interpolation, so the px values are inlined here). */
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
        gap: 8px;
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
      }
    `,
  ];

  static $html = html`
    <div id="header">
      <p class="header-label">Show geometry</p>
      <div id="toggle"></div>
    </div>
    <div id="grid"></div>
  `;
}

export class GradientSplatStoryBook extends Storybook.Default {
  title(): string {
    return "Gradient Splat — current";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Wash, with a Geometry toggle for the backing shapes",
        render: () => GradientSplatGallery.makeWith(),
      },
    ];
  }
}
