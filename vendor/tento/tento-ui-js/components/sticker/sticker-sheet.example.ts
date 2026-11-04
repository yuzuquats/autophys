import { DragDrop } from "../../drag-drop";
import { Storybook } from "../../ui/storybook";
import { StickerArtCatalog } from "./sticker-art-catalog";
import { StickerMaterialVariant } from "./sticker-material-variant";
import { StickerSheet } from "./sticker-sheet";

export class StickerSheetStoryBook extends Storybook.Default {
  title(): string {
    return "Sticker Sheet";
  }

  examples(): Storybook.Example[] {
    return [
      ...StickerSheetStoryBook.SET_VARIANTS.map((variant) => ({
        title: `Set: ${variant.title}`,
        render: () =>
          StickerSheetStoryBook.$sheet("plain", null, variant.setId),
      })),
      ...StickerSheetStoryBook.BACKGROUND_VARIANTS.map((variant) => ({
        title: `Background Slots: ${variant.title}`,
        render: () =>
          StickerSheetStoryBook.$sheet(
            variant.effectVariant,
            variant.backgrounds(),
            StickerArtCatalog.DEFAULT_SET_ID,
          ),
      })),
      ...StickerSheetStoryBook.VARIANTS.map((variant) => ({
        title: StickerMaterialVariant.label(variant),
        render: () =>
          StickerSheetStoryBook.$sheet(
            variant,
            null,
            StickerArtCatalog.DEFAULT_SET_ID,
          ),
      })),
    ];
  }
}

export namespace StickerSheetStoryBook {
  const TEXTURE_BASE = "https://static.lona.so/img/stickers/textures";

  export type BackgroundSlot = "header-background" | "body-background";

  export type BackgroundSlots = {
    header: HTMLElement;
    body: HTMLElement;
  };

  export type BackgroundVariant = {
    title: string;
    effectVariant: StickerMaterialVariant.Id;
    backgrounds: () => Option<BackgroundSlots>;
  };

  export type SetVariant = {
    title: string;
    setId: StickerArtCatalog.SetId;
  };

  export const SET_VARIANTS: readonly SetVariant[] = [
    {
      title: "Pixel Art",
      setId: StickerArtCatalog.DEFAULT_SET_ID,
    },
    {
      title: "Beluga Cats",
      setId: "beluga-cats",
    },
  ];

  export const BACKGROUND_VARIANTS: readonly BackgroundVariant[] = [
    {
      title: "Fallback Solid",
      effectVariant: "plain",
      backgrounds: () => null,
    },
    {
      title: "Solid Header And Body",
      effectVariant: "foil-satin-animated",
      backgrounds: () => ({
        header: $solidBackground(
          "header-background",
          "color-mix(in srgb, var(--yellow) 22%, var(--bg))",
        ),
        body: $solidBackground(
          "body-background",
          "color-mix(in srgb, var(--teal) 10%, var(--bg))",
        ),
      }),
    },
    {
      title: "Paper Header With Solid Body",
      effectVariant: "shimmer-rain-animated",
      backgrounds: () => ({
        header: $textureBackground(
          "header-background",
          "paper-speckle.svg",
          "color-mix(in srgb, var(--orange) 18%, var(--bg))",
          "96px 96px",
        ),
        body: $solidBackground(
          "body-background",
          "color-mix(in srgb, var(--gray) 8%, var(--bg))",
        ),
      }),
    },
    {
      title: "Solid Header With Pixel Body",
      effectVariant: "holo-grid-animated",
      backgrounds: () => ({
        header: $solidBackground(
          "header-background",
          "color-mix(in srgb, var(--blue) 14%, var(--bg))",
        ),
        body: $textureBackground(
          "body-background",
          "pixel-grid.svg",
          "color-mix(in srgb, var(--blue) 4%, var(--bg))",
          "48px 48px",
        ),
      }),
    },
    {
      title: "Texture Header And Body",
      effectVariant: "holo-prism-animated",
      backgrounds: () => ({
        header: $textureBackground(
          "header-background",
          "paper-speckle.svg",
          "color-mix(in srgb, var(--purple) 18%, var(--bg))",
          "96px 96px",
        ),
        body: $textureBackground(
          "body-background",
          "pixel-grid.svg",
          "color-mix(in srgb, var(--purple) 5%, var(--bg))",
          "48px 48px",
        ),
      }),
    },
  ];

  export const VARIANTS: readonly StickerMaterialVariant.Id[] = [
    "plain",
    "foil-satin-animated",
    "foil-ripple-animated",
    "foil-moire-animated",
    "holo-prism-animated",
    "holo-grid-animated",
    "holo-burst-animated",
    "holo-scan-animated",
    "poly-facet-animated",
    "poly-orbit-animated",
    "shimmer-rain-animated",
    "shimmer-veil-animated",
    "negative-ink-animated",
    "negative-neon-animated",
    "negative-flare-animated",
  ];

  export function $sheet(
    effectVariant: StickerMaterialVariant.Id,
    backgrounds: Option<BackgroundSlots>,
    setId: StickerArtCatalog.SetId,
  ): StickerSheet {
    const $sheet = StickerSheet.make().bind({
      controller: new DragDrop.Controller(),
      setId,
      effectVariant,
    });
    if (backgrounds) {
      $sheet.appendChild(backgrounds.header);
      $sheet.appendChild(backgrounds.body);
    }
    $sheet.assignStyles({
      width: "360px",
    });
    return $sheet;
  }

  export function $solidBackground(
    slot: BackgroundSlot,
    color: string,
  ): HTMLElement {
    const $background = document.createElement("div");
    $background.slot = slot;
    $background.assignStyles({
      background: color,
    });
    return $background;
  }

  export function $textureBackground(
    slot: BackgroundSlot,
    fileName: string,
    color: string,
    size: string,
  ): HTMLElement {
    const $background = document.createElement("div");
    $background.slot = slot;
    $background.assignStyles({
      backgroundColor: color,
      backgroundImage: `url("${TEXTURE_BASE}/${fileName}")`,
      backgroundRepeat: "repeat",
      backgroundSize: size,
    });
    return $background;
  }
}
