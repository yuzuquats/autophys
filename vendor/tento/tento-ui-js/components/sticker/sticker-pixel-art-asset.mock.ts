import { StickerArtCatalog } from "./sticker-art-catalog";

export namespace MockStickerPixelArtAsset {
  export const PIXEL_ART_SOURCE_SIZE_PX = 24;
  export const PIXEL_ART_SOURCE_WIDTH_PX = 24;
  export const PIXEL_ART_SOURCE_HEIGHT_PX = 24;
  export const PIXEL_ART_DISPLAY_SCALE = 3;
  export const PIXEL_ART_RASTER_SCALE = PIXEL_ART_DISPLAY_SCALE;
  export const PIXEL_ART_SCALE = PIXEL_ART_DISPLAY_SCALE;
  export const PIXEL_ART_DISPLAY_SIZE_PX = 72;
  export const PIXEL_ART_SIZE_LABEL = "24x24 @ 3x";
  export const PNG_CATALOG_STATIC_PATH =
    StickerArtCatalog.PNG_CATALOG_STATIC_PATH;
  export const SOURCE_PATH_PREFIX = "/img/stickers/pixel/lona-pixel-town/";

  export type Asset = StickerArtCatalog.Asset;
  export type ImageRendering = StickerArtCatalog.ImageRendering;

  export function configureForTests(
    loadText: StickerArtCatalog.TextLoader,
    loadBytes: StickerArtCatalog.BytesLoader,
  ): void {
    StickerArtCatalog.configure({ loadText, loadBytes });
  }

  export async function assets(): Promise<readonly Asset[]> {
    return StickerArtCatalog.assets();
  }
}
