// Side-effect import: registers <std-gradient-splat-wash>. The class below is referenced
// ONLY as a type (the `hydrate` annotation), so a bare `import { GradientSplatWash }` would
// be elided at runtime and the element would never upgrade (`.bind is not a function`).
import "./gradient-splat-wash";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { LandingStickerPlayground } from "./landing-sticker-playground";
import type { StickerPopHandle } from "./landing-sticker-playground";
import type { GradientSplatWash } from "./gradient-splat-wash";
import { CURATED_WASH_IDS } from "./curated-washes";

// The sticker bento "hero": the gradient wash is a SEPARATE layer here — behind the
// interactive sticker playground — instead of living inside the playground. So the
// playground's sheet can scale (its own `transform: scale`) without ever touching the
// gradient. The wash measures the hero slot and asks GradientSplat for an SVG at
// that screen-space size, so the same seeded texture scales with the bento box
// without bitmap stretching.
@component({
  name: "std-sticker-bento-hero",
})
export class StickerBentoHero extends LonaWebComponent {
  // Cycle palettes per mount so the wash varies across loads.
  private static washCursor = 0;
  private $wash: GradientSplatWash = this.hydrate("wash");

  bind(props: StickerBentoHero.Props): this {
    const idx = StickerBentoHero.washCursor++ % CURATED_WASH_IDS.length;
    this.$wash.bind({ wash: CURATED_WASH_IDS[idx] });
    this.$("stage").replaceChildren(
      LandingStickerPlayground.makeWith({ popHandle: props.popHandle }),
    );
    return this;
  }

  static makeWith(props: StickerBentoHero.Props): StickerBentoHero {
    return (StickerBentoHero.make() as StickerBentoHero).bind(props);
  }

  static $styles = [
    css`
      :host {
        position: relative;
        display: block;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      /* The gradient wash — a SEPARATE bento-hero layer, behind the asset. */
      #wash {
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
      }
      /* Hosts the interactive sticker playground; its sheet scales INSIDE here while
         the wash above stays fixed. */
      #stage {
        position: absolute;
        inset: 0;
        z-index: 1;
      }
      #stage > * {
        display: block;
        width: 100%;
        height: 100%;
      }
    `,
  ];

  static $html = html`
    <std-gradient-splat-wash id="wash"></std-gradient-splat-wash>
    <div id="stage"></div>
  `;
}

export namespace StickerBentoHero {
  export type Props = Optional<{
    // Forwarded to the playground so the card's detach accessory can pop the
    // sheet out.
    popHandle: StickerPopHandle;
  }>;
}
