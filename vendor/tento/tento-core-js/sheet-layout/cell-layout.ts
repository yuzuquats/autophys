import { shouldStackCells, shouldSpanColumns, calculateStackSize, getConservativeSpanCount, type TimeScale } from "./timescale";
import type { LayoutSpec } from "./layout-types";

export type CellLayoutOptions = Optional<{
  background: string;
  padding: string;
  marginInline: string;
  marginBlock: string;
  drawVerticalDivider: boolean;
  card: boolean;
  canDrawCardBorder: boolean;
  labelHeightPx: number;
  disableContainment: boolean;
}>;

export type CellLayout = {
  offsetPx: number;
  cellHeightPx: number;
  cellHeightWithChildrenPx: number;
  options: Option<CellLayoutOptions>;
  stackingInfo: Option<{
    cellsPerColumn: number;
    individualCellHeight: number;
    visibleCellCount: number;
    seeMoreHeight: number;
  }>;
};

export namespace CellLayout {
  export function toIndividualHeight(
    stackHeight: number,
    stackingInfo: Option<CellLayout["stackingInfo"]>,
  ): number {
    if (!stackingInfo) return stackHeight;
    const { visibleCellCount, seeMoreHeight } = stackingInfo;
    return (stackHeight - seeMoreHeight) / visibleCellCount;
  }

  export function toStackHeight(
    individualHeight: number,
    stackingInfo: Option<CellLayout["stackingInfo"]>,
  ): number {
    if (!stackingInfo) return individualHeight;
    const { visibleCellCount, seeMoreHeight } = stackingInfo;
    return visibleCellCount * individualHeight + seeMoreHeight;
  }

  export type Map<Id = unknown> = globalThis.Map<Id, CellLayout>;

  export namespace Map {
    type Row<Id> = {
      readonly id: Id;
      readonly timescaleSetting: TimeScale | "custom";
      readonly surface: "header" | "body" | "footer";
      readonly rendersChildren: boolean;
      readonly subsumed: boolean;
      readonly cellLayoutOptions: Option<CellLayoutOptions>;
      layoutSpec(sheetTimescale: TimeScale): LayoutSpec;
      children(): Row<Id>[];
    };

    export type Result<Id> = {
      maxNumFrozen: number;
      map: CellLayout.Map<Id>;
    };

    /**
     * Optional child resolver. When provided, used in place of
     * `row.children()` for every row visited by the walker.
     * Lets the body view tree (lona-js `BodyViewTree.deriveSheet`)
     * graft hoisted projection children onto the dedicated header /
     * footer rows without mutating the canonical tree. When unset,
     * defaults to `(row) => row.children()`.
     */
    export type ChildrenOf<Id> = (row: Row<Id>) => Row<Id>[];

    export function make<Id>(
      rows: Row<Id>[],
      maxHeaderHeight: number,
      sheetTimescale: TimeScale,
      childrenOf?: ChildrenOf<Id>,
    ): Result<Id> {
      const out: Result<Id> = {
        maxNumFrozen: 0,
        map: new globalThis.Map(),
      };
      const getChildren = childrenOf ?? ((r: Row<Id>) => r.children());
      generate(rows, 0, 0, maxHeaderHeight, out, sheetTimescale, getChildren);
      return out;
    }

    function generate<Id>(
      rows: Row<Id>[],
      depth: number,
      currentOffsetPx: number,
      maxHeaderHeight: number,
      out: Result<Id>,
      sheetTimescale: TimeScale,
      childrenOf: ChildrenOf<Id>,
    ): number {
      for (const row of rows) {
        if (row.subsumed) continue;
        const spec = row.layoutSpec(sheetTimescale);
        let cellHeightPx = spec.cellHeight;
        let stackingInfo: Option<CellLayout["stackingInfo"]> = null;

        if (
          spec.stackable &&
          row.surface !== "footer" &&
          shouldStackCells(row.timescaleSetting, sheetTimescale)
        ) {
          const cellsPerColumn = calculateStackSize(row.timescaleSetting, sheetTimescale);
          if (cellsPerColumn != null) {
            const individualCellHeight = spec.cellHeight;
            const availableHeight = spec.maxStackHeight ?? Number.POSITIVE_INFINITY;
            const maxCells = spec.maxStackedCells ?? cellsPerColumn;

            const cellsFitWithoutSeeMore = Math.min(
              maxCells,
              Math.floor(availableHeight / individualCellHeight),
            );

            const needsSeeMore = cellsFitWithoutSeeMore < cellsPerColumn;
            const visibleCellCount = needsSeeMore
              ? Math.min(
                  maxCells,
                  Math.floor(
                    (availableHeight - spec.seeMoreHeight) / individualCellHeight,
                  ),
                )
              : cellsFitWithoutSeeMore;
            const seeMoreHeight = needsSeeMore ? spec.seeMoreHeight : 0;

            cellHeightPx = visibleCellCount * individualCellHeight + seeMoreHeight;

            stackingInfo = {
              cellsPerColumn,
              individualCellHeight,
              visibleCellCount,
              seeMoreHeight,
            };
          }
        }

        // Span-stacked: each subcell keeps cellHeight, row = cellHeight × spanCount
        if (
          spec.minWidthTimescale &&
          shouldSpanColumns(spec.minWidthTimescale, sheetTimescale) &&
          !shouldSpanColumns(row.timescaleSetting, sheetTimescale)
        ) {
          const spanCount = getConservativeSpanCount(spec.minWidthTimescale, sheetTimescale);
          cellHeightPx = cellHeightPx * spanCount;
        }

        const children = childrenOf(row);
        // Surface-container rows (Phase D + C2) are intrinsically
        // transparent: zero `cellHeight`, no plugin. When one is
        // top-level we recurse with `depth` left at 0 so each
        // child counts toward the peek-height tally
        // (`maxNumFrozen`) individually — otherwise the whole
        // surface subtree would count as one row and a tall child
        // (e.g. the calendar template's all-day timeline) would
        // push the cumulative offset past `maxHeaderHeight`,
        // canceling the peek budget. The surface row itself is
        // skipped from the tally for the same reason: its
        // children already accumulated above.
        const isTransparentSurface =
          depth === 0 && cellHeightPx === 0 && children.length > 0;
        const childDepth = isTransparentSurface ? 0 : depth + 1;
        if (children.length > 0 && row.rendersChildren) {
          const lastOffsetPx = generate(
            children, childDepth, currentOffsetPx + cellHeightPx,
            maxHeaderHeight, out, sheetTimescale, childrenOf,
          );
          const childrenHeightPx = lastOffsetPx - currentOffsetPx;
          out.map.set(row.id, {
            offsetPx: currentOffsetPx,
            cellHeightPx,
            cellHeightWithChildrenPx: childrenHeightPx,
            options: row.cellLayoutOptions,
            stackingInfo,
          });
          currentOffsetPx += childrenHeightPx;
        } else {
          out.map.set(row.id, {
            offsetPx: currentOffsetPx,
            cellHeightPx,
            cellHeightWithChildrenPx: cellHeightPx,
            options: row.cellLayoutOptions,
            stackingInfo,
          });
          currentOffsetPx += cellHeightPx;
        }
        if (
          depth === 0 &&
          !isTransparentSurface &&
          currentOffsetPx < maxHeaderHeight &&
          row.surface !== "footer"
        ) {
          out.maxNumFrozen += 1;
        }
      }
      return currentOffsetPx;
    }
  }
}

export namespace CellLayoutOptions {
  export const EMPTY: CellLayoutOptions = {
    card: false,
    canDrawCardBorder: false,
    padding: "0px",
    marginInline: "0px",
    marginBlock: "0px",
    labelHeightPx: 32,
  };
}
