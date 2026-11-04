import { NumRangeLike } from "@tento-core/range";
import { ColumnIndex } from "./column-index";
import { NaiveDate } from "@tento-chrono";
import type { RowIdentity } from "./row-identity";

export type FixedChildXPosition =
  | {
      type: "resolved-range";
      start: ColumnIndex.Key.Resolved.WithSubindex;
      end?: ColumnIndex.Key.Resolved.WithSubindex;
    }
  | {
      type: "date-range";
      startDate: NaiveDate;
      /** INCLUSIVE — the last column the child covers, not the exclusive end
       * of its range. `FixedChild.Node.updateColumnRangeFromDates` resolves
       * this date to a column and then adds that whole column
       * (`subindex.inc()`), so `endDate === startDate` is a one-column child.
       * Callers holding an exclusive end (a `PartialDate.end`, a wire-form
       * all-day `endDate`) MUST `.addDays(-1)` first. */
      endDate: NaiveDate;
    };

export interface FixedChildSpec {
  id: string;
  x: FixedChildXPosition;
  inset: Optional<Inset>;
  widthBehavior: "fill" | "fill-right" | "auto" | number;
  makeElement: () => HTMLElement;
  onUpdate?: ($element: HTMLElement) => void;
}

export class SpecRegistry {
  private specs: Map<string, FixedChildSpec[]> = new Map();
  private suppressed: Set<string> = new Set();

  private compositeKey(rowId: RowIdentity, owner: string): string {
    return `${rowId.toString()}::${owner}`;
  }

  register(
    rowId: RowIdentity,
    owner: string,
    specs: FixedChildSpec[],
  ): void {
    const key = this.compositeKey(rowId, owner);
    this.specs.set(key, specs);
    for (const spec of specs) {
      this.suppressed.delete(spec.id);
    }
  }

  get(rowId: RowIdentity, owner: string): FixedChildSpec[] {
    return this.specs.get(this.compositeKey(rowId, owner)) ?? [];
  }

  clear(rowId: RowIdentity, owner: string): void {
    this.specs.delete(this.compositeKey(rowId, owner));
  }

  suppress(specId: string): void {
    this.suppressed.add(specId);
  }

  isSuppressed(specId: string): boolean {
    return this.suppressed.has(specId);
  }

  keys(): IterableIterator<string> {
    return this.specs.keys();
  }

  clearAll(): void {
    this.specs.clear();
    this.suppressed.clear();
  }
}

export class ViewportCuller {
  constructor(
    private registry: SpecRegistry,
    private mapper: ColumnIndex.Mapper,
  ) {}

  reconcile(
    rowId: RowIdentity,
    owner: string,
    visibleRange: NumRangeLike,
  ): FixedChildSpec[] {
    const specs = this.registry.get(rowId, owner);
    const result: FixedChildSpec[] = [];
    for (const spec of specs) {
      if (this.registry.isSuppressed(spec.id)) continue;
      const columnRange = this.resolveColumnRange(spec);
      if (columnRange && NumRangeLike.intersects(columnRange, visibleRange)) {
        result.push(spec);
      }
    }
    return result;
  }

  private resolveColumnRange(
    spec: FixedChildSpec,
  ): Option<NumRangeLike> {
    const x = spec.x;
    if (x.type === "resolved-range") {
      const start = x.start.key.offset;
      const end = x.end?.key.offset ?? start;
      return { start, end };
    }
    const startKey = ColumnIndex.Key.fromDate(x.startDate, "lower");
    const startOffset = this.mapper
      .resolveKeyToDefault(startKey, "lower").offset;
    const endKey = ColumnIndex.Key.fromDate(x.endDate, "upper");
    const endOffset = this.mapper
      .resolveKeyToDefault(endKey, "upper").offset;
    return { start: startOffset, end: endOffset };
  }
}
