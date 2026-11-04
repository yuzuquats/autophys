import { nonnull } from "@tento-core/assert";
import { CellLayout, type CellLayoutOptions } from "./cell-layout";
import type { TimeScale } from "./layout-types";

export class SheetLayoutSpec<Id = unknown> {
  readonly rowLayout: CellLayout.Map<Id>;
  readonly timescale: TimeScale;
  readonly headerHeightPx: number;
  readonly footerRowsHeightPx: number;
  readonly totalHeightPx: number;
  readonly initialScrollTop: number;
  readonly numFrozenRowsLayout: { numFrozen: number; numFrozenFlattened: number };
  readonly numFooterRowsLayout: { numFooter: number; numFooterFlattened: number };

  constructor(data: SheetLayoutSpec.Like<Id>) {
    this.rowLayout = data.rowLayout;
    this.timescale = data.timescale;
    this.headerHeightPx = data.headerHeightPx;
    this.footerRowsHeightPx = data.footerRowsHeightPx;
    this.totalHeightPx = data.totalHeightPx;
    this.initialScrollTop = data.initialScrollTop;
    this.numFrozenRowsLayout = data.numFrozenRowsLayout;
    this.numFooterRowsLayout = data.numFooterRowsLayout;
  }

  get bodyHeightPx(): number {
    return this.totalHeightPx - this.headerHeightPx - this.footerRowsHeightPx;
  }

  getRowLayout(rid: Id): Option<CellLayout> {
    return this.rowLayout.get(rid) ?? null;
  }

  equals(o: SheetLayoutSpec<Id>): boolean {
    if (this.headerHeightPx !== o.headerHeightPx) return false;
    if (this.footerRowsHeightPx !== o.footerRowsHeightPx) return false;
    if (this.totalHeightPx !== o.totalHeightPx) return false;
    if (this.initialScrollTop !== o.initialScrollTop) return false;
    if (this.numFrozenRowsLayout.numFrozen !== o.numFrozenRowsLayout.numFrozen) return false;
    if (this.numFrozenRowsLayout.numFrozenFlattened !== o.numFrozenRowsLayout.numFrozenFlattened) return false;
    if (this.numFooterRowsLayout.numFooter !== o.numFooterRowsLayout.numFooter) return false;
    if (this.numFooterRowsLayout.numFooterFlattened !== o.numFooterRowsLayout.numFooterFlattened) return false;
    if (this.rowLayout.size !== o.rowLayout.size) return false;

    for (const [key, value] of this.rowLayout) {
      const ol = o.rowLayout.get(key);
      if (!ol) return false;
      if (value.offsetPx != ol.offsetPx) return false;
      if (value.cellHeightPx != ol.cellHeightPx) return false;
      if (value.cellHeightWithChildrenPx != ol.cellHeightWithChildrenPx) return false;
      if (value.options != ol.options) {
        if (!value.options || !ol.options) return false;
        if (value.options.background != ol.options.background) return false;
        if (value.options.padding != ol.options.padding) return false;
        if (value.options.marginInline != ol.options.marginInline) return false;
        if (value.options.marginBlock != ol.options.marginBlock) return false;
        if (value.options.drawVerticalDivider != ol.options.drawVerticalDivider) return false;
        if (value.options.card != ol.options.card) return false;
        if (value.options.canDrawCardBorder != ol.options.canDrawCardBorder) return false;
      }
    }
    return true;
  }
}

export namespace SheetLayoutSpec {
  export type Like<Id = unknown> = {
    rowLayout: CellLayout.Map<Id>;
    timescale: TimeScale;
    headerHeightPx: number;
    footerRowsHeightPx: number;
    totalHeightPx: number;
    initialScrollTop: number;
    numFrozenRowsLayout: { numFrozen: number; numFrozenFlattened: number };
    numFooterRowsLayout: { numFooter: number; numFooterFlattened: number };
  };

  export type Result<Id = unknown> = {
    layout: SheetLayoutSpec<Id>;
  };

  export type Props<Id = unknown> = {
    cellLayout: CellLayout.Map.Result<Id>;
    timescale: TimeScale;
    maxHeight: number;
    numFrozenRowsSource: { numFrozen: number };
    numSystemRows: number;
    calculateFrozenRows: () => { numFrozen: number; numFrozenFlattened: number };
    numFooterRowsSource: { numFooter: number; numFooterFlattened: number };
    flattenedRows: { id: Id; initialScrollTop(ts: TimeScale): Option<number> }[];
  };

  export function make<Id = unknown>(props: Props<Id>): Result<Id> {
    const { cellLayout, timescale, maxHeight } = props;
    const rowLayout = cellLayout.map;

    // Structural header count — every flat-output row inside the
    // unique header surface row's subtree. The F3 spillover cap
    // below produces a possibly-smaller `numFrozenLayoutFlattened`
    // (the viewport-fitting subset that actually renders sticky).
    const numFrozenRowsSource = props.calculateFrozenRows();
    const structuralFrozenFlattened = numFrozenRowsSource.numFrozenFlattened;

    // F3 spillover: cap the sticky region at the viewport-fitting
    // subset. Walk flat header rows in order; the largest k where
    // `flatRows[k-1]`'s bottom edge fits within `maxHeight` is the
    // cap. Header rows past `k` stay laid out at their authored
    // offsets but are NOT pinned — they scroll with the body.
    //
    // Operates on flat output (not depth-0 units like
    // `cellLayout.maxNumFrozen`) so surface-container grandchildren
    // — the bulk of typical header content (calendar-system,
    // lunar, all-day timeline) — count correctly against the cap.
    let numFrozenLayoutFlattened = structuralFrozenFlattened;
    for (let i = 0; i < structuralFrozenFlattened; i++) {
      const row = nonnull(rowLayout.get(props.flattenedRows[i].id));
      if (row.offsetPx + row.cellHeightWithChildrenPx > maxHeight) {
        numFrozenLayoutFlattened = i;
        break;
      }
    }

    const numFrozenRowsLayout = {
      numFrozen: numFrozenRowsSource.numFrozen,
      numFrozenFlattened: numFrozenLayoutFlattened,
    };

    const numFooterRowsLayout = props.numFooterRowsSource;
    const numFooterFlattened = numFooterRowsLayout.numFooterFlattened;

    // Sticky-top region height — the (capped) last header flat
    // row's bottom edge offset. Zero when nothing fits.
    let headerHeightPx = 0;
    if (numFrozenLayoutFlattened > 0) {
      const lastRowId = props.flattenedRows[numFrozenLayoutFlattened - 1].id;
      const lastRow = nonnull(rowLayout.get(lastRowId));
      headerHeightPx = lastRow.offsetPx + lastRow.cellHeightWithChildrenPx;
    }

    const lastFlatRow = props.flattenedRows[props.flattenedRows.length - 1];
    const totalHeightPx = lastFlatRow
      ? (rowLayout.get(lastFlatRow.id)?.cellHeightWithChildrenPx ?? 0) +
        (rowLayout.get(lastFlatRow.id)?.offsetPx ?? 0)
      : 0;

    let footerRowsHeightPx = 0;
    if (numFooterFlattened > 0) {
      const footerStartIdx = props.flattenedRows.length - numFooterFlattened;
      const firstFooterRow = nonnull(rowLayout.get(props.flattenedRows[footerStartIdx].id));
      const footerStartPx = firstFooterRow.offsetPx;
      footerRowsHeightPx = totalHeightPx - footerStartPx;

      // Rebase footer row offsets to be relative to footer section start
      for (let i = footerStartIdx; i < props.flattenedRows.length; i++) {
        const row = rowLayout.get(props.flattenedRows[i].id);
        if (row) {
          row.offsetPx -= footerStartPx;
        }
      }
    }

    const firstBodyRow = props.flattenedRows[numFrozenLayoutFlattened];
    const initialScrollTop = firstBodyRow?.initialScrollTop(timescale) ?? 0;

    const layout = new SheetLayoutSpec<Id>({
      rowLayout,
      timescale,
      headerHeightPx,
      footerRowsHeightPx,
      totalHeightPx,
      initialScrollTop,
      numFrozenRowsLayout,
      numFooterRowsLayout,
    });

    return { layout };
  }
}
