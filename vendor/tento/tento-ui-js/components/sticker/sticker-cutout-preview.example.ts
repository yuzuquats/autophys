import { Tracing } from "@tento-core/tracing";
import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";

import { Storybook } from "../../ui/storybook";
import { StickerArtCatalog } from "./sticker-art-catalog";
import { StickerCutoutOutline } from "./sticker-cutout-outline";
import { StickerCutoutPreview } from "./sticker-cutout-preview";
import { StickerMaterialVariant } from "./sticker-material-variant";

export class StickerCutoutPreviewStoryBook extends Storybook.Default {
  title(): string {
    return "Sticker Effects";
  }

  examples(): Storybook.Example[] {
    return StickerMaterialVariant.ALL.map((variant) => ({
      title: variant.label,
      render: () => StickerCutoutPreviewStoryBook.$renderVariant(variant.id),
    }));
  }
}

export namespace StickerCutoutPreviewStoryBook {
  const SHADER_PRISM_LOOP_MS = 12_000;
  const STATIC_SHADER_PRISM_PHASE = 0.18;

  export function $renderVariant(
    variant: StickerMaterialVariant.Id,
  ): HTMLElement {
    const $host = document.createElement("span");
    $host.assignStyles({
      display: "inline-block",
      width: "96px",
      height: "96px",
    });
    void StickerArtCatalog.assets()
      .then((assets) => {
        const asset = assetForVariant(variant, assets);
        const $preview =
          StickerMaterialVariant.rendering(variant) === "canvas"
            ? CanvasPreview.make().bind({ asset, variant })
            : EffectPreview.make().bind({ asset, variant });
        $host.replaceChildren($preview);
      })
      .catch((err) => {
        Tracing.warn("ui")(`Sticker effect preview load failed: ${err}`);
      });
    return $host;
  }

  @component({
    name: "std-sticker-effect-preview",
  })
  export class EffectPreview extends LonaWebComponent {
    private generationId = 0;

    bind(props: EffectPreview.Props): this {
      const generationId = this.generationId + 1;
      this.generationId = generationId;
      void StickerArtCatalog.cutout(props.asset.id)
        .then((result) => {
          if (!result || generationId !== this.generationId) return;
          const $preview = StickerCutoutPreview.make().bindResult({
            result,
            alt: props.asset.alt,
            imageRendering: props.asset.imageRendering,
            displayWidth: props.asset.displayWidth,
            displayHeight: props.asset.displayHeight,
            effect: StickerMaterialVariant.effect(props.variant),
            effectVariant: props.variant,
          });
          this.replaceChildren($preview);
        })
        .catch((err) => {
          Tracing.warn("ui")(
            `Sticker effect preview: cutout generation failed: ${err}`,
          );
        });
      return this;
    }

    disconnectedCallback(): void {
      super.disconnectedCallback();
      this.generationId++;
    }
  }

  export namespace EffectPreview {
    export type Props = {
      asset: StickerArtCatalog.Asset;
      variant: StickerMaterialVariant.Id;
    };
  }

  @component({
    name: "std-sticker-effect-canvas-preview",
  })
  export class CanvasPreview extends LonaWebComponent {
    private $surface: HTMLElement = this.$("surface");
    private $preview: StickerCutoutPreview = this.hydrate("preview");
    private $canvas: HTMLCanvasElement = this.$("shader-canvas");
    private frameId: Option<number> = null;
    private generationId = 0;
    private canvasWidth = 0;
    private canvasHeight = 0;

    bind(props: CanvasPreview.Props): this {
      this.generationId++;
      this.stopAnimation();
      void this.renderAsync(props, this.generationId);
      return this;
    }

    disconnectedCallback(): void {
      super.disconnectedCallback();
      this.generationId++;
      this.stopAnimation();
    }

    private async renderAsync(
      props: CanvasPreview.Props,
      generationId: number,
    ): Promise<void> {
      const result = await StickerArtCatalog.cutout(props.asset.id).catch(
        (err) => {
          Tracing.warn("ui")(
            `Sticker shader preview: cutout generation failed: ${err}`,
          );
          return null;
        },
      );
      if (!result) return;
      if (generationId !== this.generationId) return;

      const mask = CanvasPreview.effectMaskDataUrl(result);
      const displayScaleX = props.asset.displayWidth / result.artworkWidth;
      const displayScaleY = props.asset.displayHeight / result.artworkHeight;
      const displayWidth = result.width * displayScaleX;
      const displayHeight = result.height * displayScaleY;
      this.canvasWidth = result.width;
      this.canvasHeight = result.height;
      this.assignStyles({
        "--canvas-sticker-width": `${displayWidth}px`,
        "--canvas-sticker-height": `${displayHeight}px`,
        "--effect-mask": `url("${mask}")`,
      });
      this.$surface.assignStyles({
        width: `${displayWidth}px`,
        height: `${displayHeight}px`,
      });
      this.$canvas.width = result.width;
      this.$canvas.height = result.height;
      this.$preview.bindResult({
        result,
        alt: props.asset.alt,
        imageRendering: props.asset.imageRendering,
        displayWidth: props.asset.displayWidth,
        displayHeight: props.asset.displayHeight,
        effect: "plain",
      });
      const ctx: Option<CanvasRenderingContext2D> = this.$canvas.getContext(
        "2d",
      );
      if (!ctx) return;
      drawShaderPrism(
        ctx,
        this.canvasWidth,
        this.canvasHeight,
        STATIC_SHADER_PRISM_PHASE,
      );
      if (StickerMaterialVariant.motion(props.variant) === "animated") {
        this.frameId = requestAnimationFrame(this.drawFrame);
      }
    }

    private drawFrame = (timeMs: number): void => {
      if (!this.isConnected) {
        this.frameId = null;
        return;
      }
      const ctx: Option<CanvasRenderingContext2D> = this.$canvas.getContext(
        "2d",
      );
      if (!ctx) return;
      const phase = (timeMs % SHADER_PRISM_LOOP_MS) / SHADER_PRISM_LOOP_MS;
      drawShaderPrism(ctx, this.canvasWidth, this.canvasHeight, phase);
      this.frameId = requestAnimationFrame(this.drawFrame);
    };

    private stopAnimation(): void {
      if (this.frameId == null) return;
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }

    private static effectMaskDataUrl(
      result: StickerCutoutOutline.Result,
    ): string {
      return StickerCutoutOutline.svgTextToDataUrl([
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${result.viewBox}" width="${result.width}" height="${result.height}">`,
        `  <path d="${result.pathData}" fill="#ffffff" fill-rule="evenodd" shape-rendering="geometricPrecision" />`,
        "</svg>",
      ].join("\n"));
    }

    static $styles: Style.Compat[] = [
      css`
        :host {
          display: inline-block;
          position: relative;
          width: var(--canvas-sticker-width, 0px);
          height: var(--canvas-sticker-height, 0px);
          flex-shrink: 0;
          pointer-events: none;
          filter: drop-shadow(0 0 5px rgba(0, 0, 0, 0.34));
        }

        #surface {
          position: relative;
          display: block;
        }

        #preview,
        #shader-canvas {
          position: absolute;
          inset: 0;
        }

        #shader-canvas {
          width: 100%;
          height: 100%;
          mix-blend-mode: screen;
          opacity: 0.92;
          pointer-events: none;
          -webkit-mask-image: var(--effect-mask);
          mask-image: var(--effect-mask);
          -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
          -webkit-mask-size: 100% 100%;
          mask-size: 100% 100%;
        }

        @media (prefers-reduced-motion: reduce) {
          #shader-canvas {
            opacity: 0.72;
          }
        }
      `,
    ];

    static $html: Option<HTMLTemplateElement> = html`
      <span id="surface">
        <std-sticker-cutout-preview id="preview"></std-sticker-cutout-preview>
        <canvas id="shader-canvas"></canvas>
      </span>
    `;
  }

  export namespace CanvasPreview {
    export type Props = {
      asset: StickerArtCatalog.Asset;
      variant: StickerMaterialVariant.Id;
    };
  }

  function drawShaderPrism(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    phase: number,
  ): void {
    if (width <= 0 || height <= 0) return;

    const angle = phase * Math.PI * 2;
    const image = ctx.createImageData(width, height);
    const data = image.data;
    const cx = width * 0.46 + Math.sin(angle) * width * 0.18;
    const cy = height * 0.36 + Math.cos(angle) * height * 0.14;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = x / Math.max(1, width - 1);
        const ny = y / Math.max(1, height - 1);
        const dx = (x - cx) / Math.max(1, width);
        const dy = (y - cy) / Math.max(1, height);
        const dist = Math.hypot(dx, dy);
        const waveA = Math.sin((nx * 7.2 + ny * 2.8) * Math.PI + angle);
        const waveB = Math.cos((nx * -2.4 + ny * 8.1) * Math.PI - angle);
        const glare = clamp(1 - dist * 4.2, 0, 1);
        const hue = positiveModulo(
          218 + waveA * 92 + waveB * 56 + phase * 360,
          360,
        );
        const light = clamp(0.5 + waveA * 0.08 + glare * 0.22, 0.34, 0.82);
        const rgb = hslToRgb(hue, 0.88, light);
        const alpha = Math.round(
          clamp(48 + Math.max(0, waveB) * 72 + glare * 150, 0, 230),
        );
        const offset = (y * width + x) * 4;
        data[offset] = rgb.r;
        data[offset + 1] = rgb.g;
        data[offset + 2] = rgb.b;
        data[offset + 3] = alpha;
      }
    }

    ctx.putImageData(image, 0, 0);
  }

  type Rgb = {
    r: number;
    g: number;
    b: number;
  };

  function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const huePrime = positiveModulo(hue, 360) / 60;
    const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
    const match = lightness - chroma / 2;
    const rgb = huePrime < 1
      ? { r: chroma, g: x, b: 0 }
      : huePrime < 2
      ? { r: x, g: chroma, b: 0 }
      : huePrime < 3
      ? { r: 0, g: chroma, b: x }
      : huePrime < 4
      ? { r: 0, g: x, b: chroma }
      : huePrime < 5
      ? { r: x, g: 0, b: chroma }
      : { r: chroma, g: 0, b: x };

    return {
      r: Math.round((rgb.r + match) * 255),
      g: Math.round((rgb.g + match) * 255),
      b: Math.round((rgb.b + match) * 255),
    };
  }

  function assetForVariant(
    variant: StickerMaterialVariant.Id,
    assets: readonly StickerArtCatalog.Asset[],
  ): StickerArtCatalog.Asset {
    const group = StickerMaterialVariant.choice(variant).group;
    const id = group === "foil"
      ? "signpost"
      : group === "holo"
      ? "wildflowers"
      : group === "poly"
      ? "toadstools"
      : group === "shimmer"
      ? "map-marker"
      : "wildflowers";
    const fallback = assets[0] ?? null;
    if (!fallback) throw new Error("Sticker effect preview has no assets");
    return assets.find((asset) => asset.id === id) ?? fallback;
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  function positiveModulo(value: number, modulus: number): number {
    return ((value % modulus) + modulus) % modulus;
  }
}
