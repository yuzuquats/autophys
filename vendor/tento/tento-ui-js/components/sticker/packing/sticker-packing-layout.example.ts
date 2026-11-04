import type { Point } from "@tento-core/point";

import { Column } from "../../../component-builtin";
import { NumberInputAccessory } from "../../input/number-input-accessory";
import { PropertyList } from "../../input/property-list";
import { Storybook } from "../../../ui/storybook";
import { StickerArtCatalog } from "../sticker-art-catalog";
import type { StickerCutoutOutline } from "../sticker-cutout-outline";
import { StickerCutoutPreview } from "../sticker-cutout-preview";
import { StickerMaterialVariant } from "../sticker-material-variant";
import { StickerPackingLayout } from "./sticker-packing-layout";
import { PackingStrategy } from "@tento-core/sticker-packing/packing-strategy";

const ORGANIC_COUNTS: readonly number[] = [8, 12, 24];

export class StickerPackingLayoutStoryBook extends Storybook.Default {
  title(): string {
    return "Sticker Packing Layout";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Real Sticker Playground",
        render: () => StickerPackingLayoutStoryBook.$playground(),
      },
      ...ORGANIC_COUNTS.map((count) => ({
        title: `Organic Sheet: ${count} stickers`,
        render: () => StickerPackingLayoutStoryBook.$organicCount(count),
      })),
    ];
  }
}

export namespace StickerPackingLayoutStoryBook {
  type State = {
    count: number;
    paddingPx: number;
    width: number;
    strategyId: PackingStrategy.Id;
  };

  type CatalogSticker = {
    asset: StickerArtCatalog.Asset;
    result: StickerCutoutOutline.Result;
    display: StickerCutoutPreview.ResolvedDisplay;
    polygon: readonly Point[];
  };

  const DEFAULT_COUNT = 12;
  const DEFAULT_GAP_PX = 12;
  const MAX_GAP_PX = 32;
  const MAX_COUNT = 32;

  const MATERIAL_VARIANTS: readonly StickerMaterialVariant.Id[] = [
    "plain",
    "foil-satin",
    "holo-prism",
    "poly-facet",
    "shimmer-rain",
  ];

  export function $playground(): Storybook.RenderResult {
    const state: State = {
      count: DEFAULT_COUNT,
      paddingPx: DEFAULT_GAP_PX,
      width: 360,
      strategyId: PackingStrategy.DEFAULT_ID,
    };
    return $singleStrategy(state);
  }

  export function $organicCount(count: number): Storybook.RenderResult {
    const state: State = {
      count,
      paddingPx: DEFAULT_GAP_PX,
      width: count >= 24 ? 440 : 360,
      strategyId: "organic-sheet",
    };
    return $singleStrategy(state);
  }

  function $singleStrategy(state: State): Storybook.RenderResult {
    let catalog: readonly CatalogSticker[] = [];
    let packFrame: Option<number> = null;

    const $frame = Column.make();
    $frame.assignStyles({
      width: `${state.width}px`,
      maxWidth: "100%",
      padding: "10px",
      border: "1px solid var(--divider)",
      borderRadius: "8px",
      background: "color-mix(in srgb, var(--bg) 96%, var(--blue) 4%)",
      overflow: "visible",
      transition: "width 0.3s ease",
    });

    const $layout = StickerPackingLayout.make();
    const $status = Storybook.Card.StatusLine.make();

    $status.bindText(["Loading built-in sticker cutouts"]);

    const bindLayout = (): void => {
      $frame.assignStyles({
        width: `${state.width}px`,
      });
      if (catalog.length === 0) return;
      $layout.bind({
        items: packingItems(state, catalog),
        alignX: "center",
        spacing: responsiveSpacing(state),
        options: packOptions(state),
        strategyId: state.strategyId,
        onPack: (stats) => $status.bindText(statusLines(stats)),
      });
    };

    const scheduleBindLayout = (): void => {
      if (packFrame != null) cancelAnimationFrame(packFrame);
      packFrame = requestAnimationFrame(() => {
        packFrame = null;
        bindLayout();
      });
    };

    const $controls = PropertyList.makeWith({
      count: {
        label: "Count",
        $e: $numberInput(state.count, 4, MAX_COUNT, (value) => {
          state.count = value;
          scheduleBindLayout();
        }),
        order: 0,
      },
      gap: {
        label: "Gap",
        $e: $numberInput(state.paddingPx, 0, MAX_GAP_PX, (value) => {
          state.paddingPx = value;
          scheduleBindLayout();
        }),
        order: 1,
      },
      width: {
        label: "Width",
        $e: $numberInput(state.width, 220, 640, (value) => {
          state.width = value;
          scheduleBindLayout();
        }),
        order: 2,
      },
    });

    $frame.appendChild($layout);
    void loadCatalogStickers()
      .then((loaded) => {
        catalog = loaded;
        if (catalog.length === 0) {
          $status.bindText(["No built-in sticker assets were available"]);
          return;
        }
        scheduleBindLayout();
      })
      .catch((err) => {
        $status.bindText([`Failed to load built-in sticker cutouts: ${err}`]);
      });

    return {
      $content: $frame,
      $controls,
      $status,
    };
  }

  function packOptions(state: State): StickerPackingLayout.Options {
    return {
      paddingPx: state.paddingPx,
      rotationsDeg: [0],
      order: "mixed-desc",
      geometry: {
        enabled: true,
        simplifyTolerancePx: Math.max(3, state.paddingPx * 0.5),
        minVertices: 6,
        maxAreaDeltaRatio: 0.18,
      },
    };
  }

  function packingItems(
    state: State,
    stickers: readonly CatalogSticker[],
  ): StickerPackingLayout.Item[] {
    return realStickerItems(state, stickers);
  }

  let catalogStickers: Option<CatalogSticker[]> = null;

  async function loadCatalogStickers(): Promise<readonly CatalogSticker[]> {
    if (catalogStickers) return catalogStickers;

    const loadPromises: Promise<Option<CatalogSticker>>[] = [];
    for (const asset of await StickerArtCatalog.assets()) {
      loadPromises.push(loadCatalogSticker(asset));
    }
    const loaded = await Promise.all(loadPromises);
    const items: CatalogSticker[] = [];
    for (const item of loaded) {
      if (item) items.push(item);
    }
    catalogStickers = items;
    return items;
  }

  async function loadCatalogSticker(
    asset: StickerArtCatalog.Asset,
  ): Promise<Option<CatalogSticker>> {
    const result = await StickerArtCatalog.cutout(asset.id).catch(() => null);
    if (!result) return null;
    const display = StickerCutoutPreview.resolveDisplay(result, {
      width: asset.displayWidth,
      height: asset.displayHeight,
    });
    return {
      asset,
      result,
      display,
      polygon: displayedPerimeter(result, display),
    };
  }

  function displayedPerimeter(
    result: StickerCutoutOutline.Result,
    display: StickerCutoutPreview.ResolvedDisplay,
  ): readonly Point[] {
    const scaleX = display.artworkWidth / result.artworkWidth;
    const scaleY = display.artworkHeight / result.artworkHeight;
    return result.perimeter.map((point) => ({
      x: point.x * scaleX,
      y: point.y * scaleY,
    }));
  }

  function realStickerItems(
    state: State,
    stickers: readonly CatalogSticker[],
  ): StickerPackingLayout.Item[] {
    const items: StickerPackingLayout.Item[] = [];
    for (let index = 0; index < state.count; index++) {
      const sticker = stickers[index % stickers.length] ?? null;
      if (!sticker) continue;
      items.push({
        id: `${sticker.asset.id}-${index}`,
        label: sticker.asset.label,
        polygon: sticker.polygon,
        contentSize: {
          width: sticker.display.stickerWidth,
          height: sticker.display.stickerHeight,
        },
        $content: $sticker(index, sticker),
      });
    }
    return items;
  }

  function $sticker(
    index: number,
    sticker: CatalogSticker,
  ): StickerCutoutPreview {
    const $preview = StickerCutoutPreview.make().bindResult({
      result: sticker.result,
      alt: sticker.asset.alt,
      imageRendering: sticker.asset.imageRendering,
      displayWidth: sticker.asset.displayWidth,
      displayHeight: sticker.asset.displayHeight,
      effectVariant: materialVariant(index),
    });
    return $preview;
  }

  function materialVariant(index: number): StickerMaterialVariant.Id {
    return MATERIAL_VARIANTS[index % MATERIAL_VARIANTS.length] ?? "plain";
  }

  function $numberInput(
    value: number,
    min: number,
    max: number,
    onEditingFinished: (value: number) => void,
  ): NumberInputAccessory {
    const $input = NumberInputAccessory.make();
    const bindValue = (nextValue: number): void => {
      $input.bind({
        value: nextValue,
        placeholder: String(min),
        onEditingFinished: (raw) => {
          const parsed = clamp(raw ?? nextValue, min, max);
          bindValue(parsed);
          onEditingFinished(parsed);
        },
      });
    };
    bindValue(value);
    $input.assignStyles({
      height: "24px",
      minWidth: "52px",
      marginLeft: "auto",
    });
    return $input;
  }

  function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  function statusLines(stats: StickerPackingLayout.PackStats): string[] {
    const density = `${Math.round(stats.result.density * 100)}%`;
    const runtime = `${Math.round(stats.runtimeMs)}ms`;
    const gap = `${Math.round(stats.gapPx)}px gap`;
    const whitespace = `${
      stats.whitespace.smoothNoiseScore.toFixed(1)
    } whitespace`;
    const vertices =
      `${stats.diagnostics.calculationVertexCount}/${stats.diagnostics.originalVertexCount} calc vertices`;
    const organic = `${
      stats.diagnostics.gridAlignmentPenalty.toFixed(2)
    } grid • ${stats.diagnostics.organicScore.toFixed(1)} organic`;
    return [
      `${stats.itemCount} items • ${density} density • ${gap}`,
      `${stats.strategyId} • ${whitespace} • ${runtime} pack time • ${stats.result.unplaced.length} unplaced`,
      `${vertices} • ${organic} • ${stats.diagnostics.reorderId}`,
    ];
  }

  function responsiveSpacing(
    state: State,
  ): StickerPackingLayout.ResponsiveSpacing {
    return {
      minGapPx: Math.max(0, state.paddingPx - 4),
      targetGapPx: state.paddingPx,
      maxGapPx: state.paddingPx + 6,
    };
  }
}
