import { Inset } from "@tento-core/inset";
import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import type { Point } from "@tento-core/point";

import { DomUtils } from "../../../dom";
import { Geometry } from "@tento-core/sticker-packing/geometry";
import { PackingStrategy } from "@tento-core/sticker-packing/packing-strategy";
import type {
  Bounds,
  PackOptions,
  PackResult,
  RowJustifyOptions,
  ShapeInput,
  Size,
} from "@tento-core/sticker-packing/types";

const PREVIEW_EFFECT_BLEED_PX = 6;
const DEFAULT_TARGET_GAP_PX = 12;

/**
 * Absolute-positioned visualization of silhouette-packed sticker items.
 *
 * The component owns measurement and rendering only. Callers provide already
 * prepared item content and polygons; the component derives container width
 * from its own rendered size and feeds that width into `PackingStrategy`.
 */
@component({ name: "std-sticker-packing-layout" })
export class StickerPackingLayout extends LonaWebComponent {
  private $surface: HTMLElement = this.$("surface");

  private vm: Option<StickerPackingLayout.ViewModel> = null;
  private lastContainerWidth: Option<number> = null;
  private packFrame: Option<number> = null;
  private pendingPack: boolean = false;

  onSizeChange: Option<(size: Size) => void> = (size: Size) => {
    const lastContainerWidth = this.lastContainerWidth;
    if (
      !this.pendingPack &&
      lastContainerWidth != null &&
      Math.abs(size.width - lastContainerWidth) < 1
    ) {
      return;
    }
    this.schedulePack();
  };

  static makeWith(vm: StickerPackingLayout.ViewModel): StickerPackingLayout {
    return StickerPackingLayout.make().bind(vm);
  }

  bind(vm: StickerPackingLayout.ViewModel): this {
    this.vm = vm;
    this.schedulePack();
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.schedulePack();
  }

  private schedulePack(): void {
    this.pendingPack = true;
    this.cancelScheduledPack();
    this.packFrame = requestAnimationFrame(() => {
      this.packFrame = null;
      this.packAndRender();
    });
  }

  private cancelScheduledPack(): void {
    const packFrame = this.packFrame;
    if (packFrame == null) return;
    cancelAnimationFrame(packFrame);
    this.packFrame = null;
  }

  private packAndRender(): void {
    const vm = this.vm;
    if (!vm) return;

    const measuredWidth = this.measuredContainerWidth();
    if (measuredWidth == null) return;
    const spacing = responsiveSpacing(vm.spacing ?? null, vm.options.paddingPx);
    const provisionalGapPx = responsiveGapPx(vm.items, measuredWidth, spacing);
    const provisionalOptions = {
      ...vm.options,
      paddingPx: provisionalGapPx,
    };
    const visualInsets = this.visualInsetsForItems(
      vm.items,
      provisionalOptions,
    );
    const containerWidth = Math.max(
      1,
      measuredWidth - Inset.horizontal(visualInsets),
    );
    const effectiveGapPx = responsiveGapPx(vm.items, containerWidth, spacing);
    const rowJustify = rowJustifyOptions(vm.options.rowJustify, effectiveGapPx);
    const packOptions = {
      ...vm.options,
      paddingPx: effectiveGapPx,
      rowJustify,
    };
    const finalVisualInsets = this.visualInsetsForItems(vm.items, packOptions);
    const finalContainerWidth = Math.max(
      1,
      measuredWidth - Inset.horizontal(finalVisualInsets),
    );
    this.lastContainerWidth = measuredWidth;

    const strategyId = vm.strategyId ?? PackingStrategy.DEFAULT_ID;
    const strategyOptions = vm.strategyOptions ?? {};
    const strategyMetrics = strategyOptions.metrics ?? {};
    const strategyRun = PackingStrategy.run(
      this.shapeInputs(vm.items),
      {
        ...packOptions,
        containerWidth: finalContainerWidth,
      },
      strategyId,
      {
        ...strategyOptions,
        metrics: {
          ...strategyMetrics,
          gapPx: effectiveGapPx,
        },
      },
    );
    const result = strategyRun.result;

    this.renderResult(
      vm.items,
      result,
      finalVisualInsets,
      rowJustify.alignX === "center",
    );
    this.pendingPack = false;
    vm.onPack?.({
      result,
      runtimeMs: strategyRun.runtimeMs,
      containerWidth: measuredWidth,
      itemCount: vm.items.length,
      gapPx: effectiveGapPx,
      strategyId: strategyRun.strategyId,
      whitespace: strategyRun.metrics,
      diagnostics: strategyRun.diagnostics,
    });
  }

  private shapeInputs(
    items: readonly StickerPackingLayout.Item[],
  ): ShapeInput[] {
    return items.map((item) => ({
      id: item.id,
      polygon: item.polygon,
    }));
  }

  private renderResult(
    items: readonly StickerPackingLayout.Item[],
    result: PackResult,
    visualInsets: Inset,
    skipClusterAlignment: boolean,
  ): void {
    const byId = new Map<string, StickerPackingLayout.Item>();
    for (const item of items) byId.set(item.id, item);
    const offsetX = skipClusterAlignment ? 0 : this.alignmentOffsetX(result);
    const height = result.containerHeight + Inset.vertical(visualInsets);

    DomUtils.clearChildren(this.$surface);
    this.$surface.assignStyles({
      height: `${Math.ceil(height)}px`,
    });

    for (const placement of result.placements) {
      const item = byId.get(placement.id) ?? null;
      if (!item) continue;

      const $tile = this.$tile(item);
      $tile.assignStyles({
        width: `${placement.bbox.width}px`,
        height: `${placement.bbox.height}px`,
        transform: `translate(${
          placement.translation.x + offsetX + visualInsets.left
        }px, ${placement.translation.y + visualInsets.top}px)`,
      });

      const $content = this.$content(item, placement);
      $tile.appendChild($content);
      this.$surface.appendChild($tile);
    }
  }

  private visualInsetsForItems(
    items: readonly StickerPackingLayout.Item[],
    options: StickerPackingLayout.Options,
  ): Inset {
    let insets = Inset.ZERO;
    let hasContentSize = false;
    const rotationsDeg = options.rotationsDeg ?? [0];
    const half = (options.paddingPx ?? 4) / 2;
    const eps = options.epsilon ?? Geometry.EPS;

    for (const item of items) {
      const contentSize = item.contentSize ?? null;
      if (!contentSize || !isPositiveSize(contentSize)) continue;
      hasContentSize = true;
      insets = Inset.max(
        insets,
        this.visualInsetsForItem(item, contentSize, rotationsDeg, half, eps),
      );
    }

    if (!hasContentSize) return insets;
    return Inset.ceil(Inset.add(insets, Inset.all(PREVIEW_EFFECT_BLEED_PX)));
  }

  private visualInsetsForItem(
    item: StickerPackingLayout.Item,
    contentSize: Size,
    rotationsDeg: readonly number[],
    half: number,
    eps: number,
  ): Inset {
    const raw = Geometry.ensureCcw(item.polygon);
    const rawBounds = Geometry.bounds(raw);
    const base = Geometry.translate(raw, {
      x: -rawBounds.minX,
      y: -rawBounds.minY,
    });
    if (base.length < 3 || Geometry.area(base) < eps) return Inset.ZERO;

    let insets = Inset.ZERO;
    for (const deg of rotationsDeg) {
      const rotated = deg === 0
        ? base
        : Geometry.rotate(base, deg, { x: 0, y: 0 });
      const rotatedBounds = Geometry.bounds(rotated);
      const reNorm = Geometry.translate(rotated, {
        x: -rotatedBounds.minX,
        y: -rotatedBounds.minY,
      });
      const inflated = Geometry.inflate(reNorm, half, eps);
      const inflatedBounds = Geometry.bounds(inflated);
      const body = Geometry.translate(inflated, {
        x: -inflatedBounds.minX,
        y: -inflatedBounds.minY,
      });
      const bodyBounds = Geometry.bounds(body);
      const contentBounds = transformedContentBounds(
        contentSize,
        {
          x: -rawBounds.minX,
          y: -rawBounds.minY,
        },
        deg,
        {
          x: -rotatedBounds.minX - inflatedBounds.minX,
          y: -rotatedBounds.minY - inflatedBounds.minY,
        },
      );
      insets = Inset.max(insets, bleedInsets(bodyBounds, contentBounds));
    }
    return insets;
  }

  private alignmentOffsetX(result: PackResult): number {
    const vm = this.vm;
    if (!vm || vm.alignX !== "center" || result.placements.length === 0) {
      return 0;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    for (const placement of result.placements) {
      minX = Math.min(minX, placement.translation.x);
      maxX = Math.max(maxX, placement.translation.x + placement.bbox.width);
    }

    const usedWidth = maxX - minX;
    if (
      !Number.isFinite(usedWidth) ||
      usedWidth <= 0 ||
      usedWidth >= result.containerWidth
    ) {
      return 0;
    }
    return (result.containerWidth - usedWidth) / 2 - minX;
  }

  private $tile(item: StickerPackingLayout.Item): HTMLElement {
    const $tile = document.createElement("div");
    $tile.className = "packing-tile";
    $tile.dataset.itemId = item.id;
    $tile.title = item.label;
    $tile.setAttribute("aria-label", item.label);
    return $tile;
  }

  private $content(
    item: StickerPackingLayout.Item,
    placement: PackResult["placements"][number],
  ): HTMLElement {
    const $content = document.createElement("div");
    $content.className = "packing-content";
    const localTranslation = {
      x: placement.contentTranslation.x - placement.translation.x,
      y: placement.contentTranslation.y - placement.translation.y,
    };
    $content.assignStyles({
      transform: [
        `translate(${localTranslation.x}px, ${localTranslation.y}px)`,
        `rotate(${placement.rotationDeg}deg)`,
        `translate(${placement.contentOffset.x}px, ${placement.contentOffset.y}px)`,
      ].join(" "),
    });
    $content.appendChild(item.$content);
    return $content;
  }

  private measuredContainerWidth(): Option<number> {
    if (!this.isConnected) return null;
    const surfaceWidth = this.$surface.getBoundingClientRect().width;
    const hostWidth = this.getBoundingClientRect().width;
    const parentWidth = this.parentElement?.getBoundingClientRect().width ?? 0;
    const width = Math.max(surfaceWidth, hostWidth, parentWidth);
    if (!Number.isFinite(width) || width < 2) return null;
    return Math.round(width);
  }

  onRecycle(): void {
    super.onRecycle();
    this.reset();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cancelScheduledPack();
    this.pendingPack = false;
  }

  private reset(): void {
    this.cancelScheduledPack();
    this.vm = null;
    this.lastContainerWidth = null;
    this.pendingPack = false;
    DomUtils.clearChildren(this.$surface);
    this.$surface.style.removeProperty("height");
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        width: 100%;
        min-height: 1px;
        overflow: visible;
      }

      #surface {
        position: relative;
        width: 100%;
        min-height: 1px;
        overflow: visible;
        transition: height 0.3s ease;
      }

      .packing-tile {
        position: absolute;
        top: 0px;
        left: 0px;
        box-sizing: border-box;
        border-radius: 8px;
        outline: 1px solid transparent;
        transform-origin: top left;
        transition:
          transform 0.3s ease,
          width 0.3s ease,
          height 0.3s ease,
          outline-color 0.3s ease;
      }

      .packing-tile:hover {
        z-index: 2;
        outline-color: color-mix(in srgb, var(--blue) 34%, transparent);
      }

      .packing-content {
        position: absolute;
        top: 0px;
        left: 0px;
        display: flex;
        align-items: center;
        justify-content: center;
        transform-origin: top left;
        transition: transform 0.3s ease;
        pointer-events: none;
      }

      .packing-content > * {
        display: block;
        flex-shrink: 0;
      }
      `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="surface"></div>
  `;
}

  export namespace StickerPackingLayout {
    export type Item =
      & {
        id: string;
        label: string;
        polygon: readonly Point[];
        $content: HTMLElement;
      }
      & Optional<{
        /** Rendered content box, in the same coordinate space as `polygon`. */
        contentSize: Size;
      }>;

    export type Options = Omit<PackOptions, "containerWidth">;

    export type ResponsiveSpacing = {
      minGapPx: number;
      targetGapPx: number;
      maxGapPx: number;
    };

    export type PackStats = {
      result: PackResult;
      runtimeMs: number;
      containerWidth: number;
      itemCount: number;
      gapPx: number;
      strategyId: PackingStrategy.Id;
      whitespace: PackingStrategy.Run["metrics"];
      diagnostics: PackingStrategy.Run["diagnostics"];
    };

    export type ViewModel =
      & {
        items: readonly Item[];
        options: Options;
      }
      & Optional<{
        alignX: "left" | "center";
        spacing: ResponsiveSpacing;
        strategyId: PackingStrategy.Id;
        strategyOptions: PackingStrategy.Options;
        onPack: (stats: PackStats) => void;
      }>;
  }

  function responsiveSpacing(
    configured: Option<StickerPackingLayout.ResponsiveSpacing>,
    optionGapPx: Option<number>,
  ): StickerPackingLayout.ResponsiveSpacing {
    const target = validPositiveNumber(optionGapPx) ?? DEFAULT_TARGET_GAP_PX;
    if (!configured) {
      return {
        minGapPx: Math.max(0, target - 4),
        targetGapPx: target,
        maxGapPx: target + 6,
      };
    }

    const minGapPx = Math.max(0, configured.minGapPx);
    const maxGapPx = Math.max(minGapPx, configured.maxGapPx);
    return {
      minGapPx,
      targetGapPx: clamp(configured.targetGapPx, minGapPx, maxGapPx),
      maxGapPx,
    };
  }

  function responsiveGapPx(
    items: readonly StickerPackingLayout.Item[],
    innerWidth: number,
    spacing: StickerPackingLayout.ResponsiveSpacing,
  ): number {
    const fallback = clamp(
      spacing.targetGapPx,
      spacing.minGapPx,
      spacing.maxGapPx,
    );
    const medianWidth = medianCutoutWidth(items);
    if (
      items.length < 2 ||
      medianWidth == null ||
      medianWidth <= 0 ||
      !Number.isFinite(innerWidth) ||
      innerWidth <= 0
    ) {
      return fallback;
    }

    const columns = Math.max(
      1,
      Math.min(
        items.length,
        Math.floor(
          (innerWidth + spacing.minGapPx) /
            (medianWidth + spacing.minGapPx),
        ),
      ),
    );
    if (columns < 2) return fallback;

    const gap = (innerWidth - columns * medianWidth) / Math.max(1, columns - 1);
    return clamp(gap, spacing.minGapPx, spacing.maxGapPx);
  }

  function rowJustifyOptions(
    configured: Option<RowJustifyOptions>,
    gapPx: number,
  ): RowJustifyOptions {
    if (configured) return configured;
    return {
      gapPx,
      rowTolerancePx: Math.max(2, gapPx / 2),
      alignX: "center",
    };
  }

  function medianCutoutWidth(
    items: readonly StickerPackingLayout.Item[],
  ): Option<number> {
    const widths: number[] = [];
    for (const item of items) {
      if (item.polygon.length < 3) continue;
      const width = Geometry.bounds(item.polygon).width;
      if (Number.isFinite(width) && width > 0) widths.push(width);
    }
    if (widths.length === 0) return null;
    widths.sort((a, b) => a - b);
    const mid = Math.floor(widths.length / 2);
    if (widths.length % 2 === 1) return widths[mid];
    return (widths[mid - 1] + widths[mid]) / 2;
  }

  function validPositiveNumber(value: Option<number>): Option<number> {
    if (value == null || !Number.isFinite(value) || value <= 0) return null;
    return value;
  }

  function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  function transformedContentBounds(
    contentSize: Size,
    contentOffset: Point,
    rotationDeg: number,
    contentBodyOffset: Point,
  ): Bounds {
    const corners: Point[] = [
      { x: 0, y: 0 },
      { x: contentSize.width, y: 0 },
      { x: contentSize.width, y: contentSize.height },
      { x: 0, y: contentSize.height },
    ];
    const shifted = Geometry.translate(corners, contentOffset);
    const rotated = rotationDeg === 0
      ? shifted
      : Geometry.rotate(shifted, rotationDeg, { x: 0, y: 0 });
    return Geometry.bounds(Geometry.translate(rotated, contentBodyOffset));
  }

  function bleedInsets(bodyBounds: Bounds, contentBounds: Bounds): Inset {
    return {
      top: Math.max(0, bodyBounds.minY - contentBounds.minY),
      right: Math.max(0, contentBounds.maxX - bodyBounds.maxX),
      bottom: Math.max(0, contentBounds.maxY - bodyBounds.maxY),
      left: Math.max(0, bodyBounds.minX - contentBounds.minX),
    };
  }

  function isPositiveSize(size: Size): boolean {
    return Number.isFinite(size.width) &&
      Number.isFinite(size.height) &&
      size.width > 0 &&
      size.height > 0;
  }
