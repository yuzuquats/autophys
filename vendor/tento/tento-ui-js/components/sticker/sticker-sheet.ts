import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import { Tracing } from "@tento-core/tracing";
import { DomUtils } from "@tento-ui/dom";
import { DragDrop } from "@tento-ui/drag-drop";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";

import { $$ } from "../../fastdom";
import { LonaModalHeader } from "../../ui/modal-header-styles";
import "../flippable-card";
import type { FlippableCard } from "../flippable-card";
import "../round";
import type { Round } from "../round";
import { StickerArtCatalog } from "./sticker-art-catalog";
import { StickerCutoutPreview } from "./sticker-cutout-preview";
import { StickerDrag } from "./sticker-drag";
import { StickerDragChip } from "./sticker-drag-chip";
import { StickerEffect } from "./sticker-effect";
import { StickerMaterialVariant } from "./sticker-material-variant";

const STICKER_SHEET_DEFAULT_RADIUS = 22;

/**
 * Sidebar sheet of built-in stickers. Each tile is a DragDrop source over an
 * injected, app-scoped controller, so lifting one can leave the sidebar and
 * land on the sheet sticker plugin.
 */
@component({ name: "std-sticker-sheet" })
export class StickerSheet extends LonaWebComponent {
  private readonly $card: FlippableCard = this.hydrate("card");
  private readonly $frontSurface: Round = this.hydrate("front-surface");
  private readonly $backSurface: Round = this.hydrate("back-surface");
  private readonly $front: HTMLElement = this.$("front");
  private readonly $back: HTMLElement = this.$("back");
  private readonly $title: HTMLElement = this.$("title");
  private readonly $description: HTMLElement = this.$("description");
  private readonly $grid: HTMLElement = this.$("grid");
  private readonly $sizerTitle: HTMLElement = this.$("sizer-title");
  private readonly $sizerDescription: HTMLElement = this.$("sizer-description");
  private readonly $sizerGrid: HTMLElement = this.$("sizer-grid");

  private controller: Option<DragDrop.Controller> = null;
  private readonly tiles: StickerSheet.Tile[] = [];
  private readyPreviewCount = 0;
  private chip: Option<StickerDragChip> = null;
  private effectVariant: Option<StickerMaterialVariant.Id> = null;
  private tileSizePx: Option<number> = null;
  // When set, the grid uses this fixed tile size and the asset-driven
  // `applyTileSize` is suppressed (deterministic geometry for embedders).
  private pinnedTileSize: Option<number> = null;
  // Uniformly scales each sticker's rendered display size (artwork + cutout). Lets
  // a consumer shrink the stickers — and, since the tile/bar wraps them, the row's
  // height — via layout (re-rendered smaller), with no CSS transform. Default 1.
  private displayScale: Option<number> = null;
  private previewLimit: Option<number> = null;
  private flipOnTap = true;
  private bindGeneration = 0;
  private disconnectGeneration = 0;
  private surfaceRadius: Option<number> = null;

  // Keep the std-round surface's corner radius in sync with the (CSS-var-driven)
  // sheet radius, which embedders override (e.g. the docked landing sheet pins
  // it to 16). The round auto-fits its own size, so this only re-binds when the
  // resolved radius actually changes.
  onSizeChange: Option<(s: Size) => void> = () => this.syncSurface();

  constructor() {
    super();
    this.bindSurface(STICKER_SHEET_DEFAULT_RADIUS);
    GESTURE_MANAGER.addPointerEvent(this.$front, {
      onClick: () => {
        if (this.flipOnTap) this.$card.flip("back");
      },
    });
    GESTURE_MANAGER.addPointerEvent(this.$back, {
      onClick: () => {
        if (this.flipOnTap) this.$card.flip("front");
      },
    });
  }

  // The std-round surfaces live INSIDE the flippable faces so the squircle
  // silhouette, fill, and shadow rotate with the card instead of sitting behind a
  // flipping content-only layer. The front uses the paper body tint; the back
  // matches the header tint.
  private bindSurface(radius: number): void {
    this.surfaceRadius = radius;
    this.bindRoundSurface(
      this.$frontSurface,
      radius,
      "var(--sticker-sheet-body-bg)",
    );
    this.bindRoundSurface(
      this.$backSurface,
      radius,
      "var(--sticker-sheet-header-bg)",
    );
  }

  private bindRoundSurface($surface: Round, radius: number, bg: string): void {
    $surface.bind({
      radius,
      bg,
      shadow: "var(--surface-shadow, 0 1px 2px rgba(0, 0, 0, 0.4))",
      clip: true,
    });
  }

  private syncSurface(): void {
    const raw = getComputedStyle(this)
      .getPropertyValue("--sticker-sheet-radius")
      .trim();
    const radius = Number.parseFloat(raw) || STICKER_SHEET_DEFAULT_RADIUS;
    if (this.surfaceRadius === radius) return;
    this.bindSurface(radius);
  }

  bind(vm: StickerSheet.ViewModel): this {
    const generation = this.bindGeneration + 1;
    this.bindGeneration = generation;
    this.teardownTiles();
    this.toggleAttribute("bleed", vm.bleed ?? false);
    // Layout variant: "sheet" (default vertical card) or "bar" (one horizontal
    // row, the whole thing scrolls). The consumer decides — the sheet renders
    // whatever it's told and never self-detects mobile.
    const layout = vm.layout ?? "sheet";
    this.setAttribute("layout", layout);
    this.pinnedTileSize = vm.tileSize ?? null;
    if (this.pinnedTileSize != null) {
      this.style.setProperty(
        "--sticker-sheet-tile-size",
        `${this.pinnedTileSize}px`,
      );
    }
    this.displayScale = vm.displayScale ?? null;
    this.previewLimit = vm.previewLimit ?? null;
    this.controller = vm.controller;
    this.effectVariant = vm.effectVariant ?? null;
    // A bar has no back face to flip to, so default flipOnTap off there (still
    // overridable). In bar mode the tile tap is irrelevant — drag is the action.
    this.flipOnTap = vm.flipOnTap ?? layout !== "bar";
    this.$card.flip("front");
    this.bindHeader(null);
    void this.bindSet(generation, vm.setId);
    return this;
  }

  bindPlaceholder(): this {
    const generation = this.bindGeneration + 1;
    this.bindGeneration = generation;
    this.teardownTiles();
    this.toggleAttribute("bleed", false);
    this.setAttribute("layout", "sheet");
    this.style.removeProperty("--sticker-sheet-tile-size");
    this.tileSizePx = null;
    this.pinnedTileSize = null;
    this.displayScale = null;
    this.previewLimit = null;
    this.controller = null;
    this.effectVariant = null;
    this.flipOnTap = true;
    this.$card.flip("front");
    this.bindHeader(null);
    return this;
  }

  /**
   * The header element, exposed so a floating container can use it as a drag
   * handle (it lives in this component's shadow DOM).
   */
  headerElement(): HTMLElement {
    return this.$("header");
  }

  toggleFullHeight(force: boolean): boolean {
    return this.toggleAttribute("full-height", force);
  }

  toggleExpanded(force: boolean): boolean {
    return this.toggleFullHeight(force);
  }

  previewTileCount(): number {
    return this.tiles.length;
  }

  previewReadyCount(): number {
    return this.readyPreviewCount;
  }

  private async bindSet(
    generation: number,
    setId: StickerArtCatalog.SetId,
  ): Promise<void> {
    const stickerSet = await this.loadStickerSet(setId).catch((err) => {
      Tracing.warn("ui")(`StickerSheet: failed to load sticker set: ${err}`);
      this.bindDescription(StickerSheet.LOAD_FAILURE_DESCRIPTION);
      return null;
    });
    if (generation !== this.bindGeneration) return;
    if (!stickerSet) {
      this.bindDescription(StickerSheet.LOAD_FAILURE_DESCRIPTION);
      return;
    }
    this.bindHeader(stickerSet);
    this.bindTiles(stickerSet.assets);
    this.syncPreviews();
  }

  private loadStickerSet(
    setId: StickerArtCatalog.SetId,
  ): Promise<Option<StickerArtCatalog.StickerSet>> {
    const previewLimit = this.previewLimit;
    if (previewLimit == null) return StickerArtCatalog.set(setId);
    return StickerArtCatalog.setPreview(setId, previewLimit);
  }

  private bindHeader(stickerSet: Option<StickerArtCatalog.StickerSet>): void {
    const name = stickerSet?.name ?? StickerArtCatalog.FALLBACK_SET_NAME;
    const description = stickerSet?.description ??
      StickerArtCatalog.FALLBACK_SET_DESCRIPTION;
    this.$title.textContent = name;
    this.$sizerTitle.textContent = name;
    this.bindDescription(description);
    this.applyAccent(
      stickerSet?.accent ?? StickerArtCatalog.FALLBACK_SET_ACCENT,
    );
  }

  private bindDescription(description: string): void {
    this.$description.textContent = description;
    this.$sizerDescription.textContent = description;
  }

  private applyAccent(accent: string): void {
    this.style.setProperty("--sticker-sheet-accent", accent);
    this.bindSurface(this.surfaceRadius ?? STICKER_SHEET_DEFAULT_RADIUS);
  }

  private bindTiles(assets: readonly StickerArtCatalog.Asset[]): void {
    DomUtils.clearChildren(this.$grid);
    DomUtils.clearChildren(this.$sizerGrid);
    for (const asset of assets) {
      const tile = this.makeTile(asset);
      this.tiles.push(tile);
      this.$grid.appendChild(tile.$button);
      this.$sizerGrid.appendChild(StickerSheet.makeTileSizer());
    }
  }

  private makeTile(asset: StickerArtCatalog.Asset): StickerSheet.Tile {
    const $button = document.createElement("button");
    $button.type = "button";
    $button.className = "tile";

    const $preview = StickerCutoutPreview.make();
    const tile = {
      asset,
      $button,
      $preview,
      previewGeneration: 0,
      previewReady: false,
    };
    $button.appendChild($preview);
    const effect = this.effect();

    this.controller?.registerSource($button, {
      payload: () =>
        StickerDrag.KIND.payload({
          stickerId: asset.id,
          effect,
          effectVariant: this.effectVariant,
        }),
      onLift: () => {
        this.bindPreview(tile, "recessed");
        this.clearChip();
        const chip = StickerDragChip.art(asset.id, effect, this.effectVariant, {
          x: 0,
          y: 0,
        });
        const rect = $button.getBoundingClientRect();
        chip.moveTo({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        this.chip = chip;
      },
      onMove: (e) => {
        const chip = this.chip;
        if (!chip) return;
        chip.setVisible(e.over == null);
        chip.moveTo({
          x: e.page.x - window.scrollX,
          y: e.page.y - window.scrollY,
        });
      },
      onSettle: () => {
        this.bindPreview(tile, "flat");
        const chip = this.chip;
        this.chip = null;
        if (chip) $$.mutate(() => chip.remove());
      },
      onTap: () => {
        if (this.flipOnTap) this.$card.flip("back");
      },
    });

    return tile;
  }

  private syncPreviews(): void {
    for (const tile of this.tiles) this.bindPreview(tile, "flat");
  }

  private bindPreview(
    tile: StickerSheet.Tile,
    depth: StickerCutoutPreview.Depth,
  ): void {
    const { asset, $preview } = tile;
    const effect = this.effect();
    const bindGeneration = this.bindGeneration;
    const previewGeneration = tile.previewGeneration + 1;
    tile.previewGeneration = previewGeneration;
    void StickerArtCatalog.cutout(asset.id)
      .then((result) => {
        if (!result) return;
        if (
          bindGeneration !== this.bindGeneration ||
          previewGeneration !== tile.previewGeneration
        ) {
          return;
        }
        // Scale the rendered display size uniformly (default 1). Fall back to the
        // cutout's natural artwork size when the asset has no explicit display
        // dimension, so scale 1 is identical to the unscaled path.
        const ds = this.displayScale ?? 1;
        const displaySize = StickerArtCatalog.resolveDisplaySize(asset);
        const displayWidth = displaySize.width * ds;
        const displayHeight = displaySize.height * ds;
        this.applyTileSize(
          StickerCutoutPreview.resolveTileSize(result, {
            width: displayWidth,
            height: displayHeight,
          }),
        );
        $preview.bindResult({
          result,
          alt: asset.alt,
          imageRendering: asset.imageRendering,
          displayWidth,
          displayHeight,
          depth,
          effect,
          effectVariant: this.effectVariant,
        });
        if (!tile.previewReady) {
          tile.previewReady = true;
          this.readyPreviewCount += 1;
        }
      })
      .catch((err) => {
        Tracing.warn("ui")(
          `StickerSheet: failed to render sticker cutout "${asset.id}": ${err}`,
        );
      });
  }

  private applyTileSize(tileSizePx: number): void {
    if (this.pinnedTileSize != null) return;
    if (this.tileSizePx != null && this.tileSizePx >= tileSizePx) return;
    this.tileSizePx = tileSizePx;
    this.style.setProperty("--sticker-sheet-tile-size", `${tileSizePx}px`);
  }

  private effect(): StickerEffect.Id {
    return this.effectVariant
      ? StickerMaterialVariant.effect(this.effectVariant)
      : StickerEffect.DEFAULT;
  }

  private clearChip(): void {
    this.chip?.remove();
    this.chip = null;
  }

  private static makeTileSizer(): HTMLElement {
    const $tile = document.createElement("div");
    $tile.className = "tile-sizer";
    return $tile;
  }

  private teardownTiles(): void {
    const controller = this.controller;
    if (controller) {
      for (const tile of this.tiles) controller.unregisterSource(tile.$button);
    }
    for (const tile of this.tiles) tile.$button.remove();
    DomUtils.clearChildren(this.$sizerGrid);
    this.tiles.length = 0;
    this.readyPreviewCount = 0;
    this.tileSizePx = null;
    this.style.removeProperty("--sticker-sheet-tile-size");
    this.clearChip();
  }

  private teardown(): void {
    this.bindGeneration++;
    this.teardownTiles();
    this.controller = null;
  }

  private scheduleDisconnectTeardown(): void {
    const generation = this.disconnectGeneration + 1;
    this.disconnectGeneration = generation;
    queueMicrotask(() => {
      if (generation !== this.disconnectGeneration || this.isConnected) return;
      this.teardown();
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.disconnectGeneration++;
  }

  onRecycle(): void {
    super.onRecycle();
    this.teardown();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.scheduleDisconnectTeardown();
  }

  static $styles: Style.Compat[] = [
    LonaModalHeader.$style,
    css`
      :host {
        display: block;
        width: 100%;
        box-sizing: border-box;
        overflow: visible;
        --sticker-sheet-grid-gap: 8px;
        --sticker-sheet-tile-size: 91px;
        --sticker-sheet-max-height: min(60vh, 420px);
        --sticker-sheet-accent: var(--purple);
        --sticker-sheet-border-width: 1px;
        --sticker-sheet-border-color: var(--divider);
        --sticker-sheet-radius: 22px;
        --sticker-sheet-header-bg: color-mix(
          in srgb,
          var(--sticker-sheet-accent) 20%,
          var(--bg)
        );
        --sticker-sheet-body-bg: color-mix(
          in srgb,
          var(--sticker-sheet-accent) 4%,
          var(--bg)
        );
      }

      #frame {
        position: relative;
        display: flex;
        flex-direction: column;
        width: 100%;
        box-sizing: border-box;
      }

      /* The flippable card is the sizing box. Each face owns its std-round
        surface, so the squircle fill and shadow rotate with the visible face. */
      #card {
        flex: none;
        width: 100%;
        height: auto;
        max-height: var(--sticker-sheet-max-height);
        min-height: 188px;
        box-sizing: border-box;
        border-radius: 0px;
        --flippable-card-face-overflow: visible;
      }

      :host([full-height]) #frame {
        height: 100%;
      }

      :host([full-height]) #card {
        flex: 1;
        height: 100%;
        max-height: none;
        min-height: 0px;
      }

      #front-surface,
      #back-surface {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
      }

      .face {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        border: none;
        overflow: hidden;
        cursor: pointer;
      }

      #front {
        position: relative;
        gap: 0px;
        background: transparent;
        height: 100%;
        color: var(--text-pri);
      }

      #sizer {
        visibility: hidden;
        pointer-events: none;
        gap: 0px;
        width: 100%;
        box-sizing: border-box;
        border-radius: var(--sticker-sheet-radius);
        max-height: var(--sticker-sheet-max-height);
        overflow: hidden;
      }

      :host([full-height]) #sizer {
        display: none;
      }

      #header,
      #sizer-header {
        position: relative;
        padding: 16px 16px 12px;
        flex-shrink: 0;
      }

      #header h1,
      #header p,
      #grid {
        position: relative;
        z-index: 1;
      }

      #header h1,
      #header p,
      #sizer-title,
      #sizer-description {
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #body,
      #sizer-body {
        position: relative;
        min-height: 0px;
        width: 100%;
        box-sizing: border-box;
        overflow: hidden;
      }

      #body {
        flex: 1;
      }

      #grid,
      #sizer-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, var(--sticker-sheet-tile-size));
        gap: var(--sticker-sheet-grid-gap);
        align-content: start;
        justify-content: space-evenly;
        justify-items: center;
        width: 100%;
        padding: var(--sticker-sheet-grid-gap) 12px 14px;
        box-sizing: border-box;
        background: transparent;
      }

      #grid {
        height: 100%;
        overflow-y: auto;
      }

      .tile,
      .tile-sizer {
        width: var(--sticker-sheet-tile-size);
        height: var(--sticker-sheet-tile-size);
        padding: 0px;
        box-sizing: border-box;
      }

      .tile {
        display: flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0);
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
      }

      .tile:active {
        cursor: grabbing;
      }

      #back {
        background: transparent;
      }

      .background-layer {
        position: absolute;
        inset: 0px;
        z-index: 0;
        overflow: hidden;
        pointer-events: none;
      }

      .background-layer slot,
      .background-fallback {
        display: block;
        width: 100%;
        height: 100%;
      }

      .background-layer slot::slotted(*) {
        display: block;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }

      .header-background-fallback {
        background: var(--sticker-sheet-header-bg);
      }

      .body-background-fallback {
        background: var(--sticker-sheet-body-bg);
      }

      /* Header action slot (e.g. a close button) — pinned top-right. */
      slot[name="header-action"]::slotted(*) {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 2;
      }

      /* Bleed: lay out all tiles at natural height with no scroll/cap so a
        clipping container can let the grid overflow off the bottom. */
      :host([bleed]) #card {
        max-height: none;
      }

      :host([bleed]) #body {
        overflow: visible;
      }

      :host([bleed]) #grid {
        height: auto;
        overflow: visible;
      }

      /* ── Bar layout (consumer opts in via layout="bar"): one horizontal row
        that scrolls as a WHOLE. #front becomes the single horizontal scroller;
        #header is the first item and #body/#grid flatten (display: contents) so
        the SAME draggable tiles flow inline in that one row — no inner-grid
        scroll, no scroll-arrow. #sizer is hidden (it drives height in sheet
        mode), so the card is given a definite bar height instead. */
      :host([layout="bar"]) #card {
        height: calc(var(--sticker-sheet-tile-size) + 24px);
        min-height: 0px;
        max-height: none;
      }

      :host([layout="bar"]) #sizer {
        display: none;
      }

      :host([layout="bar"]) #front {
        flex-direction: row;
        flex-wrap: nowrap;
        align-items: center;
        gap: var(--sticker-sheet-grid-gap);
        padding: 0px 12px;
        overflow-x: auto;
        overflow-y: hidden;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none; /* Firefox — scroll stays, bar hidden */
      }

      :host([layout="bar"]) #front::-webkit-scrollbar {
        display: none; /* WebKit */
      }

      /* The bar is not a flip target, so its face must not read as clickable —
        drop the .face flip pointer (the tiles keep their own grab cursor). */
      :host([layout="bar"]) .face {
        cursor: default;
      }

      :host([layout="bar"]) #header {
        flex: none;
        max-width: 45%;
        padding: 0px 4px;
      }

      :host([layout="bar"]) #body,
      :host([layout="bar"]) #grid {
        display: contents;
      }

      /* The bar reads directly on the surface paper — no header/body color band. */
      :host([layout="bar"]) .background-layer {
        display: none;
      }

      :host([layout="bar"]) .tile {
        flex: none;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="frame">
      <!-- The 3D flip works on Chrome; Firefox culls content re-slotted through
        std-round's shadow slot inside a preserve-3d + backface-visibility face
        (front renders blank), so FlippableCard auto-drops to a flat opacity swap
        on Firefox generically (Session.isFirefox). No explicit "flat" needed. -->
      <std-flippable-card id="card">
        <std-col id="sizer" aria-hidden="true">
          <std-col id="sizer-header" class="lona-modal-header">
            <h1 id="sizer-title" class="modal-title"></h1>
            <p id="sizer-description"></p>
          </std-col>
          <div id="sizer-body">
            <div id="sizer-grid"></div>
          </div>
        </std-col>
        <std-round id="front-surface" slot="front" clip>
          <std-col id="front" class="face">
            <std-col id="header" class="lona-modal-header">
              <div class="background-layer">
                <slot name="header-background">
                  <div
                    class="background-fallback header-background-fallback"
                  >
                  </div>
                </slot>
              </div>
              <slot name="header-action"></slot>
              <h1 id="title" class="modal-title"></h1>
              <p id="description"></p>
            </std-col>
            <div id="body">
              <div class="background-layer">
                <slot name="body-background">
                  <div class="background-fallback body-background-fallback"></div>
                </slot>
              </div>
              <div id="grid"></div>
            </div>
          </std-col>
        </std-round>
        <std-round id="back-surface" slot="back" clip>
          <std-col id="back" class="face"></std-col>
        </std-round>
      </std-flippable-card>
    </div>
  `;
}

export namespace StickerSheet {
  export const LOAD_FAILURE_DESCRIPTION = "Stickers could not be loaded.";

  export type Tile = {
    asset: StickerArtCatalog.Asset;
    $button: HTMLButtonElement;
    $preview: StickerCutoutPreview;
    previewGeneration: number;
    previewReady: boolean;
  };

  export type ViewModel =
    & {
      controller: Option<DragDrop.Controller>;
      setId: StickerArtCatalog.SetId;
    }
    & Optional<{
      // How the sheet renders. "sheet" (default) is the vertical card: header on
      // top, a wrapping grid of tiles below. "bar" is a single horizontal row —
      // compact title/subtitle then the tiles, the whole thing scrolling as one —
      // for narrow/mobile contexts. The CONSUMER chooses (the sheet never detects
      // mobile itself); both layouts reuse the identical draggable tiles.
      layout: "sheet" | "bar";
      effectVariant: StickerMaterialVariant.Id;
      flipOnTap: boolean;
      // Bleed: the grid lays out all tiles at natural height with no scroll/cap, so
      // a clipping container can let it overflow (e.g. off the bottom of a card
      // hero slot).
      bleed: boolean;
      // Pin the tile size (px) instead of deriving it from the assets, giving the
      // grid a deterministic column count / height (e.g. a fixed-geometry docked
      // card). Suppresses the asset-driven `applyTileSize`.
      tileSize: number;
      // Uniformly scale each sticker's rendered display size (default 1). Shrinks
      // the stickers (and thus a wrapping bar's height) via layout — re-rendered
      // smaller — instead of a CSS transform. Pair with a matching `tileSize` to
      // keep the tile margin proportional.
      displayScale: number;
      // Limits the rendered/fetched tiles for clipped previews. Leave unset for the
      // full interactive sheet.
      previewLimit: number;
    }>;
}
