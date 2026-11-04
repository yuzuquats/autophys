// Side-effect imports: std-round / std-gradient-splat-wash /
// std-presentation-asset are referenced only by tag name in the template —
// these bare imports keep the custom elements registered in every bundle.
// The presentation-asset import closes a module cycle (medallion →
// presentation-asset → registry → medallion); it is safe because this module
// never uses the PresentationAsset class as a value (type-only annotation
// below) and the registry only references IllustrationMedallion inside
// resolve() closures, which run long after all modules evaluate.
import "../round";
import "../../brand/landing/gradient-splat-wash";
import "./presentation-asset";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GradientSplatWash } from "../../brand/landing/gradient-splat-wash";
import type { PresentationAsset } from "./presentation-asset";

/// A framed illustration tile: a std-round squircle (continuous corners) over
/// a gradient-splat wash background, with a std-presentation-asset foreground
/// — so the illustration stays swappable via `src`. Used by the
/// presentation-asset registry to give card illustrations one shared look.
@component({ name: "std-illustration-medallion" })
export class IllustrationMedallion extends LonaWebComponent {
  private $wash: GradientSplatWash = this.hydrate("wash");
  private $asset: PresentationAsset = this.hydrate("asset");

  static makeWith(props: IllustrationMedallion.Props): IllustrationMedallion {
    return (IllustrationMedallion.make() as IllustrationMedallion).bind(props);
  }

  bind(props: IllustrationMedallion.Props): this {
    this.$wash.bind({ wash: props.wash });
    // Attribute API: std-presentation-asset resolves `src` itself via
    // attributeChangedCallback (Props.bind would require alt/fit/etc.).
    // `src` MUST be set before `decorative`, and `decorative` must not sit in
    // the template: any observed attribute present at upgrade time fires
    // attributeChangedCallback from `hydrate()` — in the constructor, before
    // bind() — and the asset would render src-less and log "presentation
    // asset src required". The only construction path is makeWith(), which
    // binds before insertion, so connectedCallback never sees a missing src.
    this.$asset.setAttribute("src", props.src);
    this.$asset.setAttribute("decorative", "");
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      /* The standard --box-shadow token is a 4-value box-shadow (spread),
         which drop-shadow() can't take — so the shadow is a box-shadow on a
         border-radius matching the squircle radius; at this blur the
         rounded-rect vs squircle silhouette difference is imperceptible. */
      #round {
        width: 100%;
        height: 100%;
        border-radius: 32px;
        box-shadow: var(--box-shadow);
      }

      /* The wash blur bleeds past its box, so it clips inside a frame and
         overfills it — the gradient reaches the tile edge and the medallion
         reads as a filled squircle. The squircle shape itself comes from
         std-round's \`clip\` (a clip-path on its children, this frame
         included); overflow is the square fallback that still catches the
         blur spill before the clip-path lands. */
      #wash-frame {
        position: absolute;
        inset: 0;
        overflow: hidden;
      }

      #wash {
        position: absolute;
        inset: -20%;
        /* faded: below the wash component's 0.7 default */
        opacity: 0.5;
      }

      /* currentColor assets (e.g. illustration/stars) take the primary icon
         tone on the wash. The icon-size var scales the glyph with the tile
         (percentage of the asset stage) instead of the registry's fixed 48px
         default. */
      #asset {
        color: var(--fg-icon-pri);
        --illustration-icon-size: 40%;
      }
    `,
  ];

  static $html = html`
    <std-round
      id="round"
      radius="32"
      clip
      border="color-mix(in srgb, var(--divider) 50%, transparent)"
    >
      <div id="wash-frame">
        <std-gradient-splat-wash id="wash"></std-gradient-splat-wash>
      </div>
      <std-presentation-asset id="asset"></std-presentation-asset>
    </std-round>
  `;
}

export namespace IllustrationMedallion {
  export type Props = {
    // A curated wash id (see curated-washes.ts), e.g. "sunset-1".
    wash: string;
    // A presentation-asset registry src for the foreground illustration.
    src: string;
  };
}
