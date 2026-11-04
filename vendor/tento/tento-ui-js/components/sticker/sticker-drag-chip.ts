import { Point } from "@tento-core/point";

import { StickerArtCatalog } from "./sticker-art-catalog";
import { StickerCutoutPreview } from "./sticker-cutout-preview";
import type { StickerEffect } from "./sticker-effect";
import type { StickerMaterialVariant } from "./sticker-material-variant";

/**
 * A free-floating sticker that rides the pointer during a drag — the
 * single "ghost" visual shared by the sidebar sheet (create) and the
 * sheet overlay (move).
 *
 * It lives at the document root as a `position: fixed`, pointer-inert,
 * raised cutout, so it escapes every sheet / day-column clip and stays
 * visible wherever the pointer goes (never snapped into the grid). The
 * grabbed point of the artwork stays under the cursor (grab-relative), so
 * pickup never jumps to center.
 */
export class StickerDragChip {
  private constructor(
    private readonly $el: HTMLElement,
    /** Offset of the grabbed point from the artwork center, in viewport
     *  px. Subtracted on every move so the grabbed point tracks the
     *  cursor; `{0, 0}` keeps the chip centered under the cursor. */
    private readonly grab: Point,
  ) {}

  /** A chip showing the built-in cutout art `assetId`. */
  static art(
    assetId: string,
    effect: StickerEffect.Id,
    effectVariant: Option<StickerMaterialVariant.Id>,
    grab: Point,
  ): StickerDragChip {
    const $preview = StickerCutoutPreview.make();
    void StickerArtCatalog.asset(assetId).then((asset) => {
      if (!asset) return;
      void StickerArtCatalog.cutout(asset.id).then((result) => {
        if (!result) return;
        const displaySize = StickerArtCatalog.resolveDisplaySize(asset);
        $preview.bindResult({
          result,
          alt: asset.alt,
          imageRendering: asset.imageRendering,
          displayWidth: displaySize.width,
          displayHeight: displaySize.height,
          depth: "raised",
          effect,
          effectVariant,
        });
      });
    });
    return new StickerDragChip(mount($preview), grab);
  }

  /** Move the chip so the grabbed point sits under `client` (viewport
   *  coords). */
  moveTo(client: Point): void {
    this.$el.style.left = `${client.x - this.grab.x}px`;
    this.$el.style.top = `${client.y - this.grab.y}px`;
  }

  setVisible(visible: boolean): void {
    this.$el.style.visibility = visible ? "" : "hidden";
  }

  remove(): void {
    this.$el.remove();
  }
}

/** Float `$el` at the document root, centered on its own position so
 *  `moveTo` can place its center precisely (no scale — the resting sticker
 *  is 1.0, so the drop lands at the exact chip size). */
function mount($el: HTMLElement): HTMLElement {
  $el.style.position = "fixed";
  $el.style.zIndex = "1000";
  $el.style.pointerEvents = "none";
  $el.style.transform = "translate(-50%, -50%)";
  document.body.appendChild($el);
  return $el;
}
