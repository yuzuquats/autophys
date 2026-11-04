import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import { Tracing } from "@tento-core/tracing";

import { StickerEffect } from "./sticker-effect";
import { StickerCutoutOutline } from "./sticker-cutout-outline";
import { StickerMaterialVariant } from "./sticker-material-variant";

@component({
  name: "std-sticker-cutout-preview",
})
export class StickerCutoutPreview extends LonaWebComponent {
  private $cutoutLayer: HTMLElement = this.$("cutout-layer");
  private $artwork: HTMLImageElement = this.$("artwork");
  private $textureLayer: HTMLElement = this.$("material-texture");
  private $shineLayer: HTMLElement = this.$("material-shine");
  private $glareLayer: HTMLElement = this.$("material-glare");
  private $sparkleLayer: HTMLElement = this.$("material-sparkle");
  private $innerShadow: HTMLElement = this.$("inner-shadow");
  private generationId = 0;

  bind(props: StickerCutoutPreview.Props): this {
    const rasterScale = props.rasterScale ?? props.scale ?? 3;
    const generationId = this.generationId + 1;
    this.generationId = generationId;
    this.clearRenderedCutout();
    void this.bindCutout(props, rasterScale, generationId);

    return this;
  }

  /** Synchronous bind from a pre-generated (cached) cutout result —
   *  callers that memoize `generateSvgFromPngBytes` skip the per-bind
   *  PNG decode + trace. */
  bindResult(props: StickerCutoutPreview.ResultProps): this {
    this.generationId++;
    this.clearRenderedCutout();
    this.applyResult(
      props.result,
      props.alt,
      props.imageRendering ?? null,
      props.depth ?? "flat",
      props.displayWidth ?? null,
      props.displayHeight ?? null,
      StickerCutoutPreview.resolveEffect(
        props.effect ?? null,
        props.effectVariant ?? null,
      ),
      props.effectVariant ?? null,
    );
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.generationId++;
    this.clearRenderedCutout();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.generationId++;
  }

  private async bindCutout(
    props: StickerCutoutPreview.Props,
    rasterScale: number,
    generationId: number,
  ): Promise<void> {
    const result = await StickerCutoutOutline.generateSvgFromPngBytes(
      props.pngBytes,
      {
        id: props.id,
        style: props.cutoutStyle,
        rasterScale,
      },
    ).catch((err) => {
      Tracing.warn("ui")(
        `StickerCutoutPreview: cutout generation failed: ${err}`,
      );
      return null;
    });
    if (!result) return;

    if (generationId !== this.generationId) return;

    this.applyResult(
      result,
      props.alt,
      props.imageRendering ?? null,
      props.depth ?? "flat",
      props.displayWidth ?? null,
      props.displayHeight ?? null,
      StickerCutoutPreview.resolveEffect(
        props.effect ?? null,
        props.effectVariant ?? null,
      ),
      props.effectVariant ?? null,
    );
  }

  private applyResult(
    result: StickerCutoutOutline.Result,
    alt: string,
    imageRendering: Option<StickerCutoutPreview.ImageRendering>,
    depth: StickerCutoutPreview.Depth,
    displayWidth: Option<number>,
    displayHeight: Option<number>,
    effect: StickerEffect.Id,
    effectVariant: Option<StickerMaterialVariant.Id>,
  ): void {
    const resolvedImageRendering = imageRendering ??
      StickerCutoutPreview.DEFAULT_IMAGE_RENDERING;
    const effectMask = StickerCutoutPreview.effectMaskDataUrl(result);
    const variant = effectVariant ??
      StickerMaterialVariant.defaultForEffect(effect);
    const display = StickerCutoutPreview.resolveDisplay(result, {
      width: displayWidth,
      height: displayHeight,
    });
    this.assignStyles({
      "--sticker-width": `${display.stickerWidth}px`,
      "--sticker-height": `${display.stickerHeight}px`,
    });
    this.$cutoutLayer.assignStyles({
      backgroundImage: `url("${result.svgDataUrl}")`,
    });
    this.$artwork.src = result.pngDataUrl;
    this.$artwork.alt = alt;
    this.$artwork.draggable = false;
    this.$artwork.assignStyles({
      imageRendering: resolvedImageRendering,
      left: `${display.artworkOffsetX}px`,
      top: `${display.artworkOffsetY}px`,
      width: `${display.artworkWidth}px`,
      height: `${display.artworkHeight}px`,
    });
    this.assignEffectMask(effectMask);
    this.setAttribute("effect", effect);
    this.setAttribute("effect-variant", variant);
    this.setAttribute("effect-style", StickerMaterialVariant.style(variant));
    this.setAttribute("effect-motion", StickerMaterialVariant.motion(variant));
    this.setAttribute(
      "effect-rendering",
      StickerMaterialVariant.rendering(variant),
    );
    // Depth is a separate layer over the pure shape: flat/raised cast a
    // drop shadow on the host (single-sourced in `DROP_SHADOW`); recessed
    // instead shows the SVG inner-shadow overlay built from the same path.
    this.setAttribute("depth", depth);
    this.style.filter = StickerCutoutPreview.DROP_SHADOW[depth] ?? "";
    if (depth === "recessed") {
      const innerShadowSvg = StickerCutoutOutline.buildInnerShadowSvg(
        result.pathData,
        result.viewBox,
        result.width,
        result.height,
        StickerCutoutPreview.INNER_SHADOW,
      );
      this.$innerShadow.style.backgroundImage = `url("${
        StickerCutoutOutline.svgTextToDataUrl(innerShadowSvg)
      }")`;
    } else {
      this.$innerShadow.style.removeProperty("background-image");
    }
  }

  private assignEffectMask(effectMask: string): void {
    const mask = `url("${effectMask}")`;
    this.$textureLayer.assignStyles({ "--effect-mask": mask });
    this.$shineLayer.assignStyles({ "--effect-mask": mask });
    this.$glareLayer.assignStyles({ "--effect-mask": mask });
    this.$sparkleLayer.assignStyles({ "--effect-mask": mask });
  }

  private clearRenderedCutout(): void {
    this.removeAttribute("depth");
    this.removeAttribute("effect");
    this.removeAttribute("effect-variant");
    this.removeAttribute("effect-style");
    this.removeAttribute("effect-motion");
    this.removeAttribute("effect-rendering");
    this.style.removeProperty("filter");
    this.style.removeProperty("--sticker-width");
    this.style.removeProperty("--sticker-height");
    this.$cutoutLayer.style.removeProperty("background-image");
    this.$textureLayer.style.removeProperty("--effect-mask");
    this.$shineLayer.style.removeProperty("--effect-mask");
    this.$glareLayer.style.removeProperty("--effect-mask");
    this.$sparkleLayer.style.removeProperty("--effect-mask");
    this.$innerShadow.style.removeProperty("background-image");
    this.$artwork.removeAttribute("src");
    this.$artwork.removeAttribute("alt");
    this.$artwork.style.removeProperty("image-rendering");
    this.$artwork.style.removeProperty("left");
    this.$artwork.style.removeProperty("top");
    this.$artwork.style.removeProperty("width");
    this.$artwork.style.removeProperty("height");
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

  private static resolveEffect(
    effect: Option<StickerEffect.Id>,
    effectVariant: Option<StickerMaterialVariant.Id>,
  ): StickerEffect.Id {
    if (effect) return effect;
    if (effectVariant) return StickerMaterialVariant.effect(effectVariant);
    return StickerEffect.DEFAULT;
  }

  static resolveDisplay(
    result: StickerCutoutOutline.Result,
    requested: StickerCutoutPreview.DisplaySize,
  ): StickerCutoutPreview.ResolvedDisplay {
    const artworkWidth = resolvePositiveDisplayDimension(
      requested.width,
      result.artworkWidth,
    );
    const artworkHeight = resolvePositiveDisplayDimension(
      requested.height,
      result.artworkHeight,
    );
    const scaleX = artworkWidth / result.artworkWidth;
    const scaleY = artworkHeight / result.artworkHeight;

    return {
      stickerWidth: result.width * scaleX,
      stickerHeight: result.height * scaleY,
      artworkWidth,
      artworkHeight,
      artworkOffsetX: result.artworkOffsetX * scaleX,
      artworkOffsetY: result.artworkOffsetY * scaleY,
    };
  }

  static resolveTileSize(
    result: StickerCutoutOutline.Result,
    requested: StickerCutoutPreview.DisplaySize,
  ): number {
    const display = StickerCutoutPreview.resolveDisplay(result, requested);
    return Math.max(display.stickerWidth, display.stickerHeight);
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: inline-block;
        position: relative;
        width: var(--sticker-width, 0px);
        height: var(--sticker-height, 0px);
        flex-shrink: 0;
        contain: layout;
        isolation: isolate;
        pointer-events: none;
        --material-pointer-x: 50%;
        --material-pointer-y: 38%;
        --material-bg-x: 50%;
        --material-bg-y: 50%;
        --material-glare-opacity: 0.46;
        transition: var(--sticker-cutout-shadow-transition, filter 120ms ease-out);
      }

      :host([depth="recessed"]) {
        contain: layout paint;
      }

      :host([depth="flat"]),
      :host([depth="raised"]) {
        overflow: visible;
      }

      #cutout-layer {
        position: absolute;
        inset: 0;
        background-repeat: no-repeat;
        background-size: 100% 100%;
      }

      #artwork {
        position: absolute;
        object-fit: fill;
        image-rendering: crisp-edges;
        image-rendering: pixelated;
      }

      .material-layer {
        position: absolute;
        inset: 0;
        display: none;
        pointer-events: none;
        -webkit-mask-image: var(--effect-mask);
        mask-image: var(--effect-mask);
        -webkit-mask-repeat: no-repeat;
        mask-repeat: no-repeat;
        -webkit-mask-size: 100% 100%;
        mask-size: 100% 100%;
        background-repeat: repeat;
        transform: translateZ(0);
      }

      :host(:not([effect="plain"])) .material-layer {
        display: block;
      }

      :host([effect-style="plain"]) .material-layer {
        display: none;
      }

      #material-texture {
        opacity: 0.48;
        mix-blend-mode: screen;
      }

      #material-shine {
        opacity: 0.58;
        mix-blend-mode: color-dodge;
      }

      #material-glare {
        opacity: var(--material-glare-opacity);
        mix-blend-mode: screen;
        background:
          radial-gradient(
            circle at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.95) 0%,
            rgba(255, 255, 255, 0.42) 16%,
            rgba(255, 255, 255, 0.08) 33%,
            rgba(255, 255, 255, 0) 56%
          );
      }

      #material-sparkle {
        opacity: 0;
        mix-blend-mode: screen;
      }

      :host([effect-style="foil-satin"]) #material-texture {
        opacity: 0.66;
        background:
          repeating-linear-gradient(
            22deg,
            rgba(255, 255, 255, 0.54) 0px,
            rgba(255, 255, 255, 0.18) 2px,
            rgba(101, 119, 137, 0.34) 4px,
            rgba(245, 249, 253, 0.3) 7px
          ),
          linear-gradient(125deg, rgba(255, 255, 255, 0.58), rgba(99, 119, 134, 0.34));
        background-size: 13px 13px, 100% 100%;
      }

      :host([effect-style="foil-satin"]) #material-shine {
        opacity: 0.72;
        background:
          linear-gradient(
            112deg,
            rgba(255, 255, 255, 0) 14%,
            rgba(255, 255, 255, 0.94) 36%,
            rgba(182, 197, 210, 0.34) 47%,
            rgba(255, 255, 255, 0) 68%
          );
        background-size: 190% 190%;
        background-position: var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="foil-etched"]) #material-texture {
        opacity: 0.62;
        background:
          repeating-linear-gradient(
            35deg,
            rgba(255, 255, 255, 0.28) 0px,
            rgba(255, 255, 255, 0.28) 1px,
            rgba(81, 93, 104, 0.26) 2px,
            rgba(81, 93, 104, 0.26) 4px
          ),
          repeating-linear-gradient(
            125deg,
            rgba(255, 255, 255, 0.24) 0px,
            rgba(255, 255, 255, 0.24) 1px,
            rgba(132, 145, 158, 0.18) 2px,
            rgba(132, 145, 158, 0.18) 5px
          );
        background-size: 10px 10px, 14px 14px;
      }

      :host([effect-style="foil-etched"]) #material-shine {
        opacity: 0.38;
        background:
          linear-gradient(
            100deg,
            rgba(255, 255, 255, 0) 18%,
            rgba(255, 255, 255, 0.68) 42%,
            rgba(255, 255, 255, 0) 67%
          );
        background-size: 210% 210%;
        background-position: var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="foil-beam"]) #material-texture {
        opacity: 0.44;
        background:
          repeating-linear-gradient(
            15deg,
            rgba(255, 255, 255, 0.24) 0px,
            rgba(255, 255, 255, 0.24) 2px,
            rgba(93, 111, 128, 0.22) 3px,
            rgba(93, 111, 128, 0.22) 6px
          );
        background-size: 12px 12px;
      }

      :host([effect-style="foil-beam"]) #material-shine {
        opacity: 0.82;
        background:
          linear-gradient(
            105deg,
            rgba(255, 255, 255, 0) 18%,
            rgba(255, 255, 255, 0.96) 38%,
            rgba(191, 211, 224, 0.3) 48%,
            rgba(255, 255, 255, 0) 68%
          );
        background-size: 250% 250%;
      }

      :host([effect-style="foil-ripple"]) #material-texture {
        opacity: 0.72;
        background:
          repeating-radial-gradient(
            circle at 34% 30%,
            rgba(255, 255, 255, 0.48) 0px,
            rgba(255, 255, 255, 0.14) 3px,
            rgba(84, 103, 122, 0.32) 6px,
            rgba(255, 255, 255, 0.24) 10px
          ),
          linear-gradient(135deg, rgba(248, 252, 255, 0.56), rgba(106, 122, 136, 0.36));
        background-size: 64px 64px, 100% 100%;
      }

      :host([effect-style="foil-ripple"]) #material-shine {
        opacity: 0.76;
        background:
          radial-gradient(
            ellipse at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.96),
            rgba(255, 255, 255, 0.24) 30%,
            rgba(255, 255, 255, 0) 58%
          ),
          linear-gradient(
            118deg,
            rgba(255, 255, 255, 0) 20%,
            rgba(255, 255, 255, 0.9) 43%,
            rgba(255, 255, 255, 0) 66%
          );
        background-size: 100% 100%, 230% 230%;
        background-position: 0 0, var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="foil-moire"]) #material-texture {
        opacity: 0.72;
        background:
          repeating-linear-gradient(
            22deg,
            rgba(255, 255, 255, 0.44) 0px,
            rgba(255, 255, 255, 0.14) 2px,
            rgba(87, 103, 119, 0.32) 4px,
            rgba(255, 255, 255, 0.34) 8px
          ),
          repeating-linear-gradient(
            31deg,
            rgba(255, 255, 255, 0.32) 0px,
            rgba(255, 255, 255, 0.08) 3px,
            rgba(76, 88, 101, 0.28) 5px,
            rgba(255, 255, 255, 0.2) 11px
          ),
          linear-gradient(120deg, rgba(255, 255, 255, 0.48), rgba(110, 126, 140, 0.34));
        background-size: 26px 26px, 30px 30px, 100% 100%;
      }

      :host([effect-style="foil-moire"]) #material-shine {
        opacity: 0.78;
        background:
          linear-gradient(
            110deg,
            rgba(255, 255, 255, 0) 16%,
            rgba(255, 255, 255, 0.94) 36%,
            rgba(189, 205, 217, 0.38) 48%,
            rgba(255, 255, 255, 0) 70%
          );
        background-size: 240% 240%;
        background-position: var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="holo-prism"]) #material-texture {
        opacity: 0.7;
        background:
          linear-gradient(
            118deg,
            rgba(255, 51, 112, 0.66),
            rgba(255, 222, 74, 0.55),
            rgba(56, 236, 168, 0.58),
            rgba(54, 161, 255, 0.62),
            rgba(210, 82, 255, 0.65),
            rgba(255, 51, 112, 0.66)
          ),
          repeating-linear-gradient(
            63deg,
            rgba(255, 255, 255, 0.34) 0px,
            rgba(255, 255, 255, 0.08) 3px,
            rgba(0, 0, 0, 0.06) 6px,
            rgba(0, 0, 0, 0) 10px
          );
        background-size: 210% 210%, 18px 18px;
        background-position: var(--material-bg-x) var(--material-bg-y), 0 0;
      }

      :host([effect-style="holo-prism"]) #material-shine {
        opacity: 0.7;
        background:
          linear-gradient(
            135deg,
            rgba(255, 255, 255, 0) 18%,
            rgba(255, 255, 255, 0.92) 42%,
            rgba(255, 255, 255, 0.08) 54%,
            rgba(255, 255, 255, 0) 72%
          );
        background-size: 220% 220%;
        background-position: var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="holo-cosmos"]) #material-texture {
        opacity: 0.74;
        background:
          radial-gradient(circle at 12% 18%, rgba(255, 255, 255, 0.9) 0 1px, rgba(255, 255, 255, 0) 2px),
          radial-gradient(circle at 72% 28%, rgba(166, 246, 255, 0.72) 0 1px, rgba(255, 255, 255, 0) 3px),
          radial-gradient(circle at 36% 76%, rgba(255, 226, 112, 0.7) 0 1px, rgba(255, 255, 255, 0) 3px),
          radial-gradient(circle at 84% 72%, rgba(255, 116, 214, 0.62) 0 1px, rgba(255, 255, 255, 0) 3px),
          linear-gradient(
            122deg,
            rgba(46, 116, 255, 0.46),
            rgba(172, 74, 255, 0.42),
            rgba(54, 240, 187, 0.38),
            rgba(255, 220, 82, 0.34)
          );
        background-size: 31px 31px, 43px 43px, 37px 37px, 53px 53px, 230% 230%;
        background-position:
          0 0,
          8px 4px,
          13px 17px,
          21px 11px,
          var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="holo-cosmos"]) #material-shine {
        opacity: 0.45;
        background:
          conic-gradient(
            from 80deg at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.05),
            rgba(95, 214, 255, 0.62),
            rgba(255, 105, 211, 0.58),
            rgba(255, 255, 255, 0.08),
            rgba(255, 226, 83, 0.5),
            rgba(255, 255, 255, 0.05)
          );
      }

      :host([effect-style="holo-oil"]) #material-texture,
      :host([effect-style="shader-prism"]) #material-texture {
        opacity: 0.72;
        background:
          conic-gradient(
            from 20deg at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 58, 109, 0.65),
            rgba(255, 211, 74, 0.5),
            rgba(69, 238, 185, 0.58),
            rgba(49, 151, 255, 0.65),
            rgba(176, 77, 255, 0.67),
            rgba(255, 58, 109, 0.65)
          ),
          radial-gradient(
            circle at 28% 20%,
            rgba(255, 255, 255, 0.46),
            rgba(255, 255, 255, 0) 34%
          );
        background-size: 170% 170%, 100% 100%;
      }

      :host([effect-style="holo-oil"]) #material-shine,
      :host([effect-style="shader-prism"]) #material-shine {
        opacity: 0.54;
        background:
          radial-gradient(
            circle at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.86),
            rgba(255, 255, 255, 0.12) 32%,
            rgba(255, 255, 255, 0) 58%
          );
      }

      :host([effect-style="holo-grid"]) #material-texture {
        opacity: 0.78;
        mix-blend-mode: hard-light;
        background:
          linear-gradient(
            118deg,
            rgba(238, 44, 112, 0.58),
            rgba(224, 176, 42, 0.48),
            rgba(32, 198, 158, 0.52),
            rgba(42, 112, 230, 0.6),
            rgba(164, 52, 224, 0.6),
            rgba(238, 44, 112, 0.58)
          ),
          repeating-linear-gradient(
            0deg,
            rgba(60, 232, 204, 0.24) 0px,
            rgba(60, 232, 204, 0.24) 1px,
            rgba(255, 255, 255, 0) 1px,
            rgba(255, 255, 255, 0) 9px
          ),
          repeating-linear-gradient(
            90deg,
            rgba(218, 66, 180, 0.18) 0px,
            rgba(218, 66, 180, 0.18) 1px,
            rgba(255, 255, 255, 0) 1px,
            rgba(255, 255, 255, 0) 9px
          );
        background-size: 220% 220%, 18px 18px, 18px 18px;
        background-position: var(--material-bg-x) var(--material-bg-y), 0 0, 0 0;
      }

      :host([effect-style="holo-grid"]) #material-shine {
        opacity: 0.44;
        background:
          conic-gradient(
            from 45deg at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.04),
            rgba(235, 203, 82, 0.42),
            rgba(74, 198, 232, 0.48),
            rgba(220, 84, 190, 0.44),
            rgba(255, 255, 255, 0.04)
          );
      }

      :host([effect-style="holo-burst"]) #material-texture {
        opacity: 0.72;
        background:
          radial-gradient(circle at 50% 42%, rgba(255, 255, 255, 0.82) 0 5%, rgba(255, 255, 255, 0) 24%),
          conic-gradient(
            from 25deg at 50% 48%,
            rgba(255, 55, 126, 0.64),
            rgba(255, 219, 67, 0.54),
            rgba(47, 229, 177, 0.58),
            rgba(50, 140, 255, 0.66),
            rgba(200, 74, 255, 0.66),
            rgba(255, 55, 126, 0.64)
          ),
          repeating-radial-gradient(
            circle at 50% 48%,
            rgba(255, 255, 255, 0.2) 0px,
            rgba(255, 255, 255, 0.04) 5px,
            rgba(0, 0, 0, 0.04) 10px,
            rgba(255, 255, 255, 0) 16px
          );
        background-size: 100% 100%, 190% 190%, 64px 64px;
        background-position: 0 0, var(--material-bg-x) var(--material-bg-y), 0 0;
      }

      :host([effect-style="holo-burst"]) #material-shine {
        opacity: 0.68;
        background:
          radial-gradient(
            circle at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.94),
            rgba(255, 255, 255, 0.18) 24%,
            rgba(255, 255, 255, 0) 56%
          ),
          linear-gradient(
            135deg,
            rgba(255, 255, 255, 0) 18%,
            rgba(255, 255, 255, 0.76) 44%,
            rgba(255, 255, 255, 0) 68%
          );
        background-size: 100% 100%, 230% 230%;
        background-position: 0 0, var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="holo-scan"]) #material-texture {
        opacity: 0.7;
        background:
          linear-gradient(
            115deg,
            rgba(250, 54, 124, 0.54),
            rgba(255, 210, 70, 0.44),
            rgba(49, 224, 182, 0.48),
            rgba(55, 137, 255, 0.56),
            rgba(184, 70, 255, 0.56),
            rgba(250, 54, 124, 0.54)
          ),
          repeating-linear-gradient(
            0deg,
            rgba(255, 255, 255, 0.38) 0px,
            rgba(255, 255, 255, 0.1) 2px,
            rgba(0, 0, 0, 0) 6px,
            rgba(0, 0, 0, 0) 14px
          );
        background-size: 220% 220%, 100% 28px;
        background-position: var(--material-bg-x) var(--material-bg-y), 0 0;
      }

      :host([effect-style="holo-scan"]) #material-shine {
        opacity: 0.58;
        background:
          linear-gradient(
            90deg,
            rgba(255, 255, 255, 0) 10%,
            rgba(255, 255, 255, 0.72) 48%,
            rgba(255, 255, 255, 0) 80%
          );
        background-size: 180% 100%;
        background-position: var(--material-bg-x) 0;
      }

      :host([effect-style="poly-chroma"]) #material-texture {
        opacity: 0.78;
        background:
          conic-gradient(
            from 45deg,
            rgba(255, 30, 102, 0.7),
            rgba(255, 221, 63, 0.6),
            rgba(20, 226, 171, 0.66),
            rgba(45, 127, 255, 0.72),
            rgba(207, 54, 255, 0.74),
            rgba(255, 30, 102, 0.7)
          );
        background-size: 150% 150%;
        background-position: var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="poly-chroma"]) #material-shine {
        opacity: 0.72;
        background:
          linear-gradient(
            154deg,
            rgba(255, 255, 255, 0) 16%,
            rgba(255, 255, 255, 0.92) 44%,
            rgba(255, 255, 255, 0) 68%
          );
        background-size: 230% 230%;
        background-position: var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="poly-pixel"]) #material-texture {
        opacity: 0.76;
        background:
          repeating-linear-gradient(
            0deg,
            rgba(255, 63, 111, 0.68) 0px,
            rgba(255, 63, 111, 0.68) 8px,
            rgba(255, 219, 74, 0.6) 8px,
            rgba(255, 219, 74, 0.6) 16px,
            rgba(52, 226, 184, 0.62) 16px,
            rgba(52, 226, 184, 0.62) 24px,
            rgba(79, 133, 255, 0.68) 24px,
            rgba(79, 133, 255, 0.68) 32px
          ),
          repeating-linear-gradient(
            90deg,
            rgba(255, 255, 255, 0.18) 0px,
            rgba(255, 255, 255, 0.18) 6px,
            rgba(0, 0, 0, 0.08) 6px,
            rgba(0, 0, 0, 0.08) 12px
        );
        background-size: 32px 32px, 24px 24px;
      }

      :host([effect-style="poly-pixel"]) #material-shine {
        opacity: 0.36;
        background:
          linear-gradient(
            115deg,
            rgba(255, 255, 255, 0) 18%,
            rgba(255, 255, 255, 0.88) 42%,
            rgba(255, 255, 255, 0) 64%
        );
        background-size: 220% 220%;
      }

      :host([effect-style="poly-plasma"]) #material-texture {
        opacity: 0.8;
        background:
          radial-gradient(circle at 24% 18%, rgba(255, 240, 95, 0.74), rgba(255, 240, 95, 0) 32%),
          radial-gradient(circle at 78% 28%, rgba(62, 232, 255, 0.68), rgba(62, 232, 255, 0) 34%),
          radial-gradient(circle at 50% 82%, rgba(255, 54, 156, 0.72), rgba(255, 54, 156, 0) 38%),
          conic-gradient(
            from 210deg,
            rgba(255, 38, 103, 0.5),
            rgba(73, 237, 184, 0.5),
            rgba(61, 121, 255, 0.58),
            rgba(223, 66, 255, 0.58),
            rgba(255, 38, 103, 0.5)
          );
        background-size: 130% 130%, 120% 120%, 150% 150%, 180% 180%;
        background-position:
          var(--material-bg-x) var(--material-bg-y),
          30% 20%,
          55% 80%,
          50% 50%;
      }

      :host([effect-style="poly-plasma"]) #material-shine {
        opacity: 0.62;
        background:
          radial-gradient(
            circle at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.86),
            rgba(255, 255, 255, 0.12) 24%,
            rgba(255, 255, 255, 0) 58%
          );
      }

      :host([effect-style="poly-facet"]) #material-texture {
        opacity: 0.82;
        background:
          conic-gradient(
            from 18deg at 45% 50%,
            rgba(255, 40, 112, 0.74) 0deg 45deg,
            rgba(255, 224, 68, 0.62) 45deg 96deg,
            rgba(45, 230, 179, 0.66) 96deg 154deg,
            rgba(65, 134, 255, 0.72) 154deg 226deg,
            rgba(218, 68, 255, 0.72) 226deg 308deg,
            rgba(255, 40, 112, 0.74) 308deg 360deg
          ),
          linear-gradient(36deg, rgba(255, 255, 255, 0.3), rgba(0, 0, 0, 0.08));
        background-size: 160% 160%, 100% 100%;
        background-position: var(--material-bg-x) var(--material-bg-y), 0 0;
      }

      :host([effect-style="poly-facet"]) #material-shine {
        opacity: 0.68;
        background:
          repeating-linear-gradient(
            132deg,
            rgba(255, 255, 255, 0.72) 0px,
            rgba(255, 255, 255, 0.08) 7px,
            rgba(0, 0, 0, 0) 16px
          );
        background-size: 42px 42px;
        background-position: var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="poly-orbit"]) #material-texture {
        opacity: 0.8;
        background:
          radial-gradient(circle at 22% 24%, rgba(255, 238, 79, 0.8), rgba(255, 238, 79, 0) 34%),
          radial-gradient(circle at 78% 30%, rgba(48, 235, 188, 0.74), rgba(48, 235, 188, 0) 36%),
          radial-gradient(circle at 48% 82%, rgba(255, 55, 148, 0.76), rgba(255, 55, 148, 0) 38%),
          conic-gradient(
            from 145deg at 50% 50%,
            rgba(60, 132, 255, 0.64),
            rgba(221, 68, 255, 0.6),
            rgba(255, 69, 121, 0.58),
            rgba(61, 232, 188, 0.58),
            rgba(60, 132, 255, 0.64)
          );
        background-size: 128% 128%, 118% 118%, 136% 136%, 170% 170%;
        background-position:
          22% 24%,
          78% 30%,
          48% 82%,
          var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="poly-orbit"]) #material-shine {
        opacity: 0.7;
        background:
          radial-gradient(
            circle at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.88),
            rgba(255, 255, 255, 0.16) 22%,
            rgba(255, 255, 255, 0) 52%
          ),
          linear-gradient(
            130deg,
            rgba(255, 255, 255, 0) 18%,
            rgba(255, 255, 255, 0.8) 42%,
            rgba(255, 255, 255, 0) 66%
          );
        background-size: 100% 100%, 230% 230%;
        background-position: 0 0, var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="shimmer-sweep"]) #material-texture {
        opacity: 0.24;
        background:
          linear-gradient(25deg, rgba(255, 232, 112, 0.2), rgba(72, 217, 255, 0.24));
      }

      :host([effect-style="shimmer-sweep"]) #material-shine {
        opacity: 0.78;
        background:
          linear-gradient(
            105deg,
            rgba(255, 255, 255, 0) 18%,
            rgba(255, 255, 255, 0.95) 38%,
            rgba(255, 255, 255, 0.16) 52%,
            rgba(255, 255, 255, 0) 70%
          );
        background-size: 240% 240%;
      }

      :host([effect-style="shimmer-sparkle"]) #material-texture {
        opacity: 0.28;
        background:
          linear-gradient(25deg, rgba(255, 232, 112, 0.18), rgba(72, 217, 255, 0.22));
      }

      :host([effect-style="shimmer-sparkle"]) #material-shine {
        opacity: 0.74;
        background:
          linear-gradient(
            106deg,
            rgba(255, 255, 255, 0) 18%,
            rgba(255, 255, 255, 0.94) 38%,
            rgba(255, 255, 255, 0.12) 54%,
            rgba(255, 255, 255, 0) 72%
          );
        background-size: 240% 240%;
      }

      :host([effect-style="shimmer-sparkle"]) #material-sparkle {
        opacity: 0.82;
        background:
          radial-gradient(circle at 12% 26%, rgba(255, 255, 255, 0.92) 0 1px, rgba(255, 255, 255, 0) 3px),
          radial-gradient(circle at 64% 18%, rgba(255, 255, 255, 0.85) 0 1px, rgba(255, 255, 255, 0) 3px),
          radial-gradient(circle at 38% 72%, rgba(255, 255, 255, 0.78) 0 1px, rgba(255, 255, 255, 0) 3px),
          radial-gradient(circle at 82% 66%, rgba(255, 255, 255, 0.84) 0 1px, rgba(255, 255, 255, 0) 3px);
        background-size: 34px 34px, 42px 42px, 38px 38px, 46px 46px;
      }

      :host([effect-style="shimmer-glass"]) #material-texture {
        opacity: 0.42;
        background:
          linear-gradient(115deg, rgba(255, 255, 255, 0.18), rgba(111, 216, 255, 0.18), rgba(255, 238, 155, 0.16)),
          repeating-linear-gradient(
            130deg,
            rgba(255, 255, 255, 0.22) 0px,
            rgba(255, 255, 255, 0.06) 4px,
            rgba(0, 0, 0, 0) 12px
          );
        background-size: 100% 100%, 24px 24px;
      }

      :host([effect-style="shimmer-glass"]) #material-shine {
        opacity: 0.76;
        background:
          radial-gradient(
            ellipse at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.88),
            rgba(255, 255, 255, 0.2) 18%,
            rgba(255, 255, 255, 0) 46%
          ),
          linear-gradient(
            122deg,
            rgba(255, 255, 255, 0) 24%,
            rgba(255, 255, 255, 0.74) 46%,
            rgba(255, 255, 255, 0) 58%
          );
        background-size: 100% 100%, 220% 220%;
        background-position: 0 0, var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="shimmer-rain"]) #material-texture {
        opacity: 0.48;
        background:
          linear-gradient(28deg, rgba(255, 235, 118, 0.24), rgba(82, 219, 255, 0.34)),
          repeating-linear-gradient(
            114deg,
            rgba(255, 255, 255, 0) 0px,
            rgba(255, 255, 255, 0) 8px,
            rgba(255, 255, 255, 0.68) 9px,
            rgba(255, 255, 255, 0.18) 13px,
            rgba(255, 255, 255, 0) 19px
          );
        background-size: 100% 100%, 28px 28px;
      }

      :host([effect-style="shimmer-rain"]) #material-shine {
        opacity: 0.86;
        background:
          linear-gradient(
            112deg,
            rgba(255, 255, 255, 0) 12%,
            rgba(255, 255, 255, 0.98) 34%,
            rgba(255, 255, 255, 0.26) 47%,
            rgba(255, 255, 255, 0) 72%
          );
        background-size: 260% 260%;
        background-position: var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="shimmer-veil"]) #material-texture {
        opacity: 0.46;
        background:
          radial-gradient(ellipse at 22% 18%, rgba(255, 255, 255, 0.54), rgba(255, 255, 255, 0) 42%),
          radial-gradient(ellipse at 72% 74%, rgba(84, 218, 255, 0.36), rgba(84, 218, 255, 0) 46%),
          linear-gradient(124deg, rgba(255, 238, 144, 0.26), rgba(255, 255, 255, 0.12), rgba(92, 221, 255, 0.28));
        background-size: 120% 120%, 130% 130%, 180% 180%;
        background-position:
          22% 18%,
          72% 74%,
          var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-style="shimmer-veil"]) #material-shine {
        opacity: 0.82;
        background:
          linear-gradient(
            104deg,
            rgba(255, 255, 255, 0) 16%,
            rgba(255, 255, 255, 0.82) 33%,
            rgba(255, 255, 255, 0.18) 48%,
            rgba(255, 255, 255, 0) 68%
          ),
          linear-gradient(
            38deg,
            rgba(255, 255, 255, 0) 24%,
            rgba(255, 255, 255, 0.42) 48%,
            rgba(255, 255, 255, 0) 64%
          );
        background-size: 240% 240%, 180% 180%;
        background-position:
          var(--material-bg-x) var(--material-bg-y),
          0 0;
      }

      :host([effect-style="negative-ink"]) #material-texture {
        opacity: 0.5;
        mix-blend-mode: multiply;
        background:
          linear-gradient(135deg, rgba(32, 40, 62, 0.52), rgba(62, 74, 104, 0.4)),
          radial-gradient(circle at var(--material-pointer-x) var(--material-pointer-y), rgba(150, 184, 255, 0.72), rgba(0, 0, 0, 0) 56%);
      }

      :host([effect-style="negative-ink"]) #material-shine {
        opacity: 0.96;
        mix-blend-mode: screen;
        background:
          conic-gradient(
            from 220deg at var(--material-pointer-x) var(--material-pointer-y),
            rgba(126, 160, 255, 0.22),
            rgba(255, 126, 206, 0.9),
            rgba(126, 255, 233, 0.88),
            rgba(255, 255, 255, 0.34),
            rgba(126, 160, 255, 0.22)
          );
      }

      :host([effect-style="negative-neon"]) #material-texture {
        opacity: 0.54;
        mix-blend-mode: multiply;
        background:
          radial-gradient(circle at 28% 18%, rgba(68, 255, 236, 0.86), rgba(0, 0, 0, 0) 42%),
          radial-gradient(circle at 72% 72%, rgba(255, 98, 205, 0.82), rgba(0, 0, 0, 0) 48%),
          linear-gradient(135deg, rgba(20, 28, 50, 0.58), rgba(42, 50, 78, 0.44));
        background-size: 130% 130%, 120% 120%, 100% 100%;
        background-position:
          var(--material-bg-x) var(--material-bg-y),
          72% 72%,
          0 0;
      }

      :host([effect-style="negative-neon"]) #material-shine {
        opacity: 0.98;
        mix-blend-mode: screen;
        background:
          conic-gradient(
            from 120deg at var(--material-pointer-x) var(--material-pointer-y),
            rgba(87, 255, 241, 0.18),
            rgba(72, 255, 238, 0.96),
            rgba(255, 92, 204, 0.92),
            rgba(255, 247, 148, 0.66),
            rgba(87, 255, 241, 0.18)
          );
      }

      :host([effect-style="negative-flare"]) #material-texture {
        opacity: 0.46;
        mix-blend-mode: multiply;
        background:
          radial-gradient(circle at 24% 22%, rgba(94, 255, 240, 0.9), rgba(0, 0, 0, 0) 44%),
          radial-gradient(circle at 76% 76%, rgba(255, 112, 214, 0.88), rgba(0, 0, 0, 0) 48%),
          linear-gradient(135deg, rgba(40, 50, 78, 0.42), rgba(68, 78, 108, 0.34));
        background-size: 128% 128%, 124% 124%, 100% 100%;
        background-position:
          24% 22%,
          76% 76%,
          0 0;
      }

      :host([effect-style="negative-flare"]) #material-shine {
        opacity: 1;
        mix-blend-mode: screen;
        background:
          radial-gradient(
            circle at var(--material-pointer-x) var(--material-pointer-y),
            rgba(255, 255, 255, 0.64),
            rgba(255, 255, 255, 0.12) 22%,
            rgba(255, 255, 255, 0) 54%
          ),
          conic-gradient(
            from 170deg at var(--material-pointer-x) var(--material-pointer-y),
            rgba(110, 255, 240, 0.12),
            rgba(99, 255, 240, 0.96),
            rgba(255, 116, 210, 0.94),
            rgba(255, 247, 148, 0.76),
            rgba(110, 255, 240, 0.12)
          );
        background-size: 100% 100%, 180% 180%;
        background-position: 0 0, var(--material-bg-x) var(--material-bg-y);
      }

      :host([effect-motion="animated"]) #material-glare {
        animation: sticker-material-glare-loop 11.2s linear infinite;
      }

      :host([effect-motion="animated"][effect-style="foil-satin"]) #material-texture,
      :host([effect-motion="animated"][effect-style="foil-etched"]) #material-texture,
      :host([effect-motion="animated"][effect-style="foil-beam"]) #material-texture,
      :host([effect-motion="animated"][effect-style="foil-ripple"]) #material-texture,
      :host([effect-motion="animated"][effect-style="holo-prism"]) #material-texture,
      :host([effect-motion="animated"][effect-style="holo-cosmos"]) #material-texture,
      :host([effect-motion="animated"][effect-style="holo-oil"]) #material-texture,
      :host([effect-motion="animated"][effect-style="holo-grid"]) #material-texture,
      :host([effect-motion="animated"][effect-style="poly-chroma"]) #material-texture,
      :host([effect-motion="animated"][effect-style="poly-plasma"]) #material-texture,
      :host([effect-motion="animated"][effect-style="poly-facet"]) #material-texture,
      :host([effect-motion="animated"][effect-style="negative-ink"]) #material-shine,
      :host([effect-motion="animated"][effect-style="negative-neon"]) #material-texture,
      :host([effect-motion="animated"][effect-style="negative-neon"]) #material-shine {
        animation: sticker-material-drift-loop 12s linear infinite;
      }

      :host([effect-motion="animated"][effect-style="foil-satin"]) #material-shine,
      :host([effect-motion="animated"][effect-style="foil-etched"]) #material-shine,
      :host([effect-motion="animated"][effect-style="foil-beam"]) #material-shine,
      :host([effect-motion="animated"][effect-style="foil-ripple"]) #material-shine,
      :host([effect-motion="animated"][effect-style="holo-prism"]) #material-shine,
      :host([effect-motion="animated"][effect-style="poly-chroma"]) #material-shine,
      :host([effect-motion="animated"][effect-style="poly-pixel"]) #material-shine,
      :host([effect-motion="animated"][effect-style="poly-facet"]) #material-shine,
      :host([effect-motion="animated"][effect-style="shimmer-sweep"]) #material-shine,
      :host([effect-motion="animated"][effect-style="shimmer-sparkle"]) #material-shine,
      :host([effect-motion="animated"][effect-style="shimmer-glass"]) #material-shine,
      :host([effect-motion="animated"][effect-style="shimmer-rain"]) #material-shine {
        animation: sticker-material-sweep-loop 8.8s linear infinite;
      }

      :host([effect-motion="animated"][effect-style="poly-pixel"]) #material-texture,
      :host([effect-motion="animated"][effect-style="holo-grid"]) #material-shine,
      :host([effect-motion="animated"][effect-style="shimmer-rain"]) #material-texture {
        animation: sticker-material-tile-loop 7.2s linear infinite;
      }

      :host([effect-motion="animated"][effect-style="shimmer-sparkle"]) #material-sparkle,
      :host([effect-motion="animated"][effect-style="holo-cosmos"]) #material-shine {
        animation: sticker-material-sparkle-loop 6.4s linear infinite;
      }

      :host([effect-motion="animated"][effect-style="holo-grid"]) #material-texture {
        animation: sticker-material-holo-grid-loop 12s linear infinite;
      }

      :host([effect-motion="animated"][effect-style="holo-grid"]) #material-shine {
        opacity: 0.62;
      }

      :host([effect-motion="animated"][effect-style="foil-satin"]) #material-texture,
      :host([effect-motion="animated"][effect-style="foil-ripple"]) #material-texture {
        filter: contrast(1.14) saturate(1.08);
      }

      :host([effect-motion="animated"][effect-style="foil-satin"]) #material-shine,
      :host([effect-motion="animated"][effect-style="foil-ripple"]) #material-shine {
        opacity: 0.92;
      }

      :host([effect-motion="animated"][effect-style="shimmer-rain"]) #material-texture {
        opacity: 0.62;
        filter: contrast(1.12);
      }

      :host([effect-motion="animated"][effect-style="shimmer-rain"]) #material-shine {
        opacity: 0.98;
      }

      :host([effect-motion="animated"][effect-style="negative-ink"]) #material-texture {
        opacity: 0.42;
      }

      :host([effect-motion="animated"][effect-style="negative-ink"]) #material-shine {
        opacity: 1;
        filter: brightness(1.18) saturate(1.12);
      }

      :host([effect-motion="animated"][effect-style="foil-ripple"]) #material-texture {
        animation: sticker-material-foil-ripple-loop 9.6s linear infinite;
        filter: contrast(1.18) saturate(1.08);
      }

      :host([effect-motion="animated"][effect-style="foil-ripple"]) #material-shine {
        animation: sticker-material-foil-ripple-shine-loop 9.6s linear infinite;
        opacity: 0.96;
      }

      :host([effect-motion="animated"][effect-style="foil-moire"]) #material-texture {
        animation: sticker-material-moire-loop 12s linear infinite;
        filter: contrast(1.2) saturate(1.06);
      }

      :host([effect-motion="animated"][effect-style="foil-moire"]) #material-shine,
      :host([effect-motion="animated"][effect-style="holo-burst"]) #material-shine,
      :host([effect-motion="animated"][effect-style="holo-scan"]) #material-shine,
      :host([effect-motion="animated"][effect-style="poly-orbit"]) #material-shine,
      :host([effect-motion="animated"][effect-style="shimmer-veil"]) #material-shine {
        animation: sticker-material-sweep-loop 10.4s linear infinite;
      }

      :host([effect-motion="animated"][effect-style="foil-moire"]) #material-shine {
        opacity: 0.94;
      }

      :host([effect-motion="animated"][effect-style="holo-burst"]) #material-texture {
        animation: sticker-material-burst-loop 12s linear infinite;
        filter: contrast(1.08) saturate(1.18);
      }

      :host([effect-motion="animated"][effect-style="holo-burst"]) #material-shine {
        opacity: 0.9;
      }

      :host([effect-motion="animated"][effect-style="holo-scan"]) #material-texture {
        animation: sticker-material-scan-loop 10.8s linear infinite;
        filter: contrast(1.08) saturate(1.16);
      }

      :host([effect-motion="animated"][effect-style="holo-scan"]) #material-shine {
        opacity: 0.78;
      }

      :host([effect-motion="animated"][effect-style="poly-orbit"]) #material-texture {
        animation: sticker-material-orbit-loop 12.8s linear infinite;
        filter: saturate(1.18);
      }

      :host([effect-motion="animated"][effect-style="poly-orbit"]) #material-shine {
        opacity: 0.88;
      }

      :host([effect-motion="animated"][effect-style="shimmer-veil"]) #material-texture {
        animation: sticker-material-veil-loop 11.6s linear infinite;
        opacity: 0.64;
        filter: contrast(1.08);
      }

      :host([effect-motion="animated"][effect-style="shimmer-veil"]) #material-shine {
        opacity: 0.96;
      }

      :host([effect-motion="animated"][effect-style="negative-flare"]) #material-texture,
      :host([effect-motion="animated"][effect-style="negative-flare"]) #material-shine {
        animation: sticker-material-negative-flare-loop 12s linear infinite;
      }

      :host([effect-motion="animated"][effect-style="negative-flare"]) #material-texture {
        opacity: 0.4;
      }

      :host([effect-motion="animated"][effect-style="negative-flare"]) #material-shine {
        opacity: 1;
        filter: brightness(1.16) saturate(1.16);
      }

      #inner-shadow {
        position: absolute;
        inset: 0;
        display: none;
        background-repeat: no-repeat;
        background-size: 100% 100%;
        pointer-events: none;
      }

      :host([depth="recessed"]) #inner-shadow {
        display: block;
      }

      :host([depth="recessed"]) #cutout-layer,
      :host([depth="recessed"]) #artwork,
      :host([depth="recessed"]) .material-layer {
        display: none;
      }

      @keyframes sticker-material-sweep-loop {
        0%,
        100% {
          opacity: 0.18;
          background-position: -120% 50%, 0 0;
        }
        45%,
        55% {
          opacity: 0.88;
          background-position: 120% 50%, 0 0;
        }
      }

      @keyframes sticker-material-drift-loop {
        0%,
        100% {
          background-position: 0% 45%, 30% 20%, 55% 80%, 50% 50%;
          filter: hue-rotate(0deg) saturate(1.16);
        }
        50% {
          background-position: 100% 55%, 36% 24%, 48% 72%, 70% 50%;
          filter: hue-rotate(180deg) saturate(1.36);
        }
      }

      @keyframes sticker-material-tile-loop {
        0%,
        100% {
          background-position: 0 0, 0 0, 0 0;
          filter: hue-rotate(0deg);
        }
        50% {
          background-position: 32px 32px, 24px 24px, 18px 18px;
          filter: hue-rotate(180deg);
        }
      }

      @keyframes sticker-material-holo-grid-loop {
        0%,
        100% {
          background-position: 0% 45%, 0 0, 0 0;
          filter: contrast(1.12) saturate(1.12);
        }
        50% {
          background-position: 100% 55%, 18px 18px, 18px 18px;
          filter: contrast(1.18) saturate(1.24);
        }
      }

      @keyframes sticker-material-sparkle-loop {
        0%,
        100% {
          opacity: 0.42;
          background-position: 0 0, 8px 4px, 13px 17px, 21px 11px;
          filter: hue-rotate(0deg);
        }
        50% {
          opacity: 0.9;
          background-position: 34px 34px, 50px 46px, 51px 55px, 67px 57px;
          filter: hue-rotate(180deg);
        }
      }

      @keyframes sticker-material-glare-loop {
        0%,
        100% {
          opacity: 0.22;
          filter: hue-rotate(0deg) saturate(1);
        }
        50% {
          opacity: var(--material-glare-opacity);
          filter: hue-rotate(180deg) saturate(1.28);
        }
      }

      @keyframes sticker-material-foil-ripple-loop {
        0%,
        100% {
          background-position: 0 0, 0 0;
          background-size: 56px 56px, 100% 100%;
        }
        50% {
          background-position: 36px 30px, 0 0;
          background-size: 88px 88px, 100% 100%;
        }
      }

      @keyframes sticker-material-foil-ripple-shine-loop {
        0%,
        100% {
          opacity: 0.62;
          background-position: 0 0, -130% 50%;
        }
        50% {
          opacity: 0.98;
          background-position: 0 0, 130% 50%;
        }
      }

      @keyframes sticker-material-moire-loop {
        0%,
        100% {
          background-position: 0 0, 0 0, 0 0;
        }
        50% {
          background-position: 26px -18px, -30px 20px, 0 0;
        }
      }

      @keyframes sticker-material-burst-loop {
        0%,
        100% {
          background-position: 0 0, 0% 45%, 0 0;
          background-size: 100% 100%, 190% 190%, 64px 64px;
        }
        50% {
          background-position: 0 0, 100% 55%, 32px 32px;
          background-size: 100% 100%, 214% 214%, 92px 92px;
        }
      }

      @keyframes sticker-material-scan-loop {
        0%,
        100% {
          background-position: 0% 45%, 0 0;
        }
        50% {
          background-position: 100% 55%, 0 28px;
        }
      }

      @keyframes sticker-material-orbit-loop {
        0%,
        100% {
          background-position: 22% 24%, 78% 30%, 48% 82%, 0% 45%;
        }
        25% {
          background-position: 72% 22%, 76% 78%, 24% 62%, 50% 52%;
        }
        50% {
          background-position: 78% 74%, 22% 70%, 52% 18%, 100% 55%;
        }
        75% {
          background-position: 28% 78%, 24% 24%, 76% 42%, 50% 48%;
        }
      }

      @keyframes sticker-material-veil-loop {
        0%,
        100% {
          background-position: 22% 18%, 72% 74%, 0% 50%;
        }
        50% {
          background-position: 72% 24%, 28% 78%, 100% 50%;
        }
      }

      @keyframes sticker-material-negative-flare-loop {
        0%,
        100% {
          background-position: 24% 22%, 76% 76%, 0 0;
        }
        50% {
          background-position: 72% 24%, 28% 74%, 0 0;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .material-layer {
          animation: none !important;
        }
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <span id="cutout-layer"></span>
    <img id="artwork" />
    <span id="material-texture" class="material-layer"></span>
    <span id="material-shine" class="material-layer"></span>
    <span id="material-glare" class="material-layer"></span>
    <span id="material-sparkle" class="material-layer"></span>
    <span id="inner-shadow"></span>
  `;
}

export namespace StickerCutoutPreview {
  export type ImageRendering = "auto" | "pixelated";

  export const DEFAULT_IMAGE_RENDERING: ImageRendering = "pixelated";

  /** How the sticker reads relative to the surface, mirroring distance to
   *  the paper: `flat` (docked / resting, a small shadow), `raised` (picked up,
   *  drop shadow), `recessed` (the empty imprint left in the source sheet
   *  when a sticker is removed — the same silhouette "in reverse": an inner
   *  shadow over the soft bg, with the paper + artwork gone). */
  export type Depth = "flat" | "raised" | "recessed";

  /** Inner-shadow tuning for the recessed depth, in the cutout's own
   *  coordinate space (stretched to the host via `background-size`). */
  export const INNER_SHADOW: StickerCutoutOutline.Shadow = {
    dxPx: 0,
    dyPx: 0,
    blurPx: 1.5,
    color: "#000000",
    opacity: 0.42,
  };

  /** Per-depth host drop shadow (symmetric, tight — reads as distance from
   *  the page). Recessed has no drop shadow — it uses the inner-shadow overlay
   *  instead. */
  export const DROP_SHADOW: Partial<Record<Depth, string>> = {
    flat: "var(--sticker-cutout-shadow-flat, drop-shadow(0 0 2px rgba(0, 0, 0, 0.28)))",
    raised: "var(--sticker-cutout-shadow-raised, drop-shadow(0 0 5px rgba(0, 0, 0, 0.34)))",
  };

  export type DisplaySize = {
    width: Option<number>;
    height: Option<number>;
  };

  export type ResolvedDisplay = {
    stickerWidth: number;
    stickerHeight: number;
    artworkWidth: number;
    artworkHeight: number;
    artworkOffsetX: number;
    artworkOffsetY: number;
  };

  export type Props =
    & {
      id: string;
      pngBytes: Uint8Array;
      alt: string;
    }
    & Optional<{
      rasterScale: number;
      scale: number;
      displayWidth: number;
      displayHeight: number;
      cutoutStyle: StickerCutoutOutline.Style;
      imageRendering: ImageRendering;
      depth: Depth;
      effect: StickerEffect.Id;
      effectVariant: StickerMaterialVariant.Id;
    }>;

  export type ResultProps =
    & {
      result: StickerCutoutOutline.Result;
      alt: string;
    }
    & Optional<{
      imageRendering: ImageRendering;
      displayWidth: number;
      displayHeight: number;
      depth: Depth;
      effect: StickerEffect.Id;
      effectVariant: StickerMaterialVariant.Id;
    }>;
}

function resolvePositiveDisplayDimension(
  value: Option<number>,
  fallback: number,
): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Sticker display dimension must be positive, got ${value}`);
  }
  return value;
}
