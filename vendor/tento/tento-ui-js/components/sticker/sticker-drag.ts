import { DragDrop } from "@tento-ui/drag-drop";
import type { StickerEffect } from "./sticker-effect";
import type { StickerMaterialVariant } from "./sticker-material-variant";

/**
 * Shared drag vocabulary for stickers. A source (the sidebar sheet)
 * and a target (the sheet's sticker plugin) agree on this `Kind` without
 * importing each other — the source publishes the sticker id +
 * material effect, and the target resolves it into a persisted sticker.
 */
export namespace StickerDrag {
  export interface Payload {
    /** Built-in sticker id (see `StickerArtCatalog`). */
    stickerId: string;
    /** Material/effect selected when the sticker drag starts. */
    effect: StickerEffect.Id;
    /** Specific material rendering variant for the in-flight preview. */
    effectVariant: Option<StickerMaterialVariant.Id>;
  }

  export const KIND = new DragDrop.Kind<Payload>("sticker-art");
}

/**
 * Drag vocabulary for moving an EXISTING sticker by its on-sheet artwork.
 * The source is the sticker overlay (the drawn cutout in the sheet's
 * fixed-child layer). The move resolves its destination from its own
 * in-sheet drag ghost on settle, not from a drop target, so the payload
 * carries only the sticker's identity (no target consumes it today; the
 * Kind exists so the seam can distinguish a move from a sheet create).
 */
export namespace StickerMoveDrag {
  export interface Payload {
    /** Raw custom-cell id of the sticker being moved. */
    cellId: string;
  }

  export const KIND = new DragDrop.Kind<Payload>("sticker-move");
}
