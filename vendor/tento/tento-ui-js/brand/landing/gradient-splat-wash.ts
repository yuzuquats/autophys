import { LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GradientSplat } from "./gradient-splat";
import { CuratedWashes } from "./curated-washes";

// The wash re-builds its gradient whenever the host box resizes (`onSizeChange` → ResizeObserver):
// it regenerates the SVG at the new container size. Blobs are an ABSOLUTE px size (see
// gradient-splat.ts), so a rebuild keeps blob size constant and the count fills the larger box.
@component({ name: "std-gradient-splat-wash" })
export class GradientSplatWash extends LonaWebComponent {
  private wash = "";
  private offsetX = 0;
  private lastRenderKey: Option<string> = null;
  private lastSize: Option<GradientSplat.RenderSize> = null;

  onSizeChange: Option<(s: Size) => void> = (size: Size) => {
    this.lastSize = size;
    this.renderForSize(size);
  };

  // Opt-in horizontal shift of the blob-cluster geometry (render px, + = right;
  // mechanism documented on Palette.backgroundForSize). Default 0 leaves every
  // other wash consumer's centered geometry untouched.
  setGeometryOffsetX(offsetX: number): this {
    if (this.offsetX === offsetX) return this;
    this.offsetX = offsetX;
    this.lastRenderKey = null;
    if (this.lastSize != null) this.renderForSize(this.lastSize);
    return this;
  }

  static makeWith(props: GradientSplatWash.Props): GradientSplatWash {
    return (GradientSplatWash.make() as GradientSplatWash).bind(props);
  }

  bind(props: GradientSplatWash.Props): this {
    this.wash = props.wash;
    this.lastRenderKey = null;
    if (this.lastSize != null) this.renderForSize(this.lastSize);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
  }

  onRecycle(): void {
    this.lastSize = null;
    super.onRecycle();
  }

  private palette(): GradientSplat.Palette {
    return CuratedWashes.byIdOr(this.wash, CuratedWashes.ALL[0]);
  }

  private renderForSize(size: GradientSplat.RenderSize): void {
    if (size.width <= 0 || size.height <= 0) return;

    const palette = this.palette();
    const renderKey = `${this.wash}:${this.offsetX}:${GradientSplat.sizeKey(size)}`;
    if (renderKey === this.lastRenderKey) return;

    this.lastRenderKey = renderKey;
    this.style.backgroundImage = palette.backgroundForSize(size, this.offsetX);
    this.style.filter = palette.blur;
  }

  static $styles = [
    css`
      :host {
        display: block;
        pointer-events: none;
        opacity: 0.7;
        background-repeat: no-repeat;
        background-position: center;
        background-size: 100% 100%;
      }
    `,
  ];
}

export namespace GradientSplatWash {
  export type Props = {
    wash: string; // a curated wash id (see CURATED_WASH_IDS in curated-washes.ts)
  };
}
