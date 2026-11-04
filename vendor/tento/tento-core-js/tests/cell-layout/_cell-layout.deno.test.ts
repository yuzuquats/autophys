import { assertEquals } from "jsr:@std/assert";
import { Fixtures } from "../fixture-runner.deno.ts";
import { CellLayout } from "@tento-ui/components/sheet/cell-layout.ts";
import { SheetLayoutSpec } from "@tento-ui/components/sheet/sheet-layout-spec.ts";
import type { LayoutSpec, TimeScale } from "@tento-ui/components/sheet/layout-types.ts";

// ── Shared types ────────────────────────────────────────────────

type RowDef = {
  id: string;
  height: number;
  isFooterRow: boolean;
  isSystem: boolean;
};

type MockRow = Parameters<typeof CellLayout.Map.make<string>>[0][number];

function toRow(def: RowDef): MockRow {
  return {
    id: def.id,
    timescaleSetting: "day" as TimeScale,
    surface: def.isFooterRow ? "footer" : "body",
    rendersChildren: false,
    subsumed: false,
    cellLayoutOptions: null,
    layoutSpec(_ts: TimeScale): LayoutSpec {
      return {
        cellHeight: def.height,
        maxStackHeight: null,
        maxStackedCells: null,
        seeMoreHeight: 0,
        stackable: false,
        spannable: false,
        minWidthTimescale: null,
      };
    },
    children(): MockRow[] {
      return [];
    },
  };
}

// ── CellLayout.Map.make: maxNumFrozen excludes footer rows ──────

type FrozenInput = {
  rows: RowDef[];
  maxHeaderHeight: number;
};

type FrozenExpected = {
  maxNumFrozen: number;
  ids: string[];
};

Fixtures.load<FrozenInput, FrozenExpected>(
  new URL(".", import.meta.url).pathname,
  "frozen-cap",
).run(
  (input) => {
    const rows = input.rows.map(toRow);
    const result = CellLayout.Map.make(rows, input.maxHeaderHeight, "week");
    return {
      maxNumFrozen: result.maxNumFrozen,
      ids: input.rows.map((r) => r.id),
    };
  },
  (result, expected) => {
    assertEquals(result.maxNumFrozen, expected.maxNumFrozen);
    assertEquals(result.ids, expected.ids);
  },
);

// ── SheetLayoutSpec.make: frozen/footer never overlap ───────────

type SpecInput = {
  rows: RowDef[];
  maxHeaderHeight: number;
  numUserFrozenRows: number;
  numSystemRows: number;
};

type SpecExpected = {
  numFrozenFlattened: number;
  numFooterFlattened: number;
  noOverlap: boolean;
};

Fixtures.load<SpecInput, SpecExpected>(
  new URL(".", import.meta.url).pathname,
  "layout-spec",
).run(
  (input) => {
    const rows = input.rows.map(toRow);
    const cellLayout = CellLayout.Map.make(rows, input.maxHeaderHeight, "week");

    // Count footer rows
    let numFooter = 0;
    for (let i = input.rows.length - 1; i >= 0; i--) {
      if (!input.rows[i].isFooterRow) break;
      numFooter++;
    }

    const flattenedRows = input.rows.map((r) => ({
      id: r.id,
      initialScrollTop: (_ts: TimeScale) => null as Option<number>,
    }));

    // Structural header count cannot exceed the non-footer row
    // tail; production's `calculateFrozenRows` enforces that via
    // the header surface subtree. Mirror the invariant here so
    // bogus fixture inputs (`numUserFrozenRows: 5` with 2 rows
    // total) test the post-E1 cap behavior rather than producing
    // NaN through arithmetic on undefined.
    const nonFooterCount = input.rows.length - numFooter;
    const numFrozenSource = Math.min(
      input.numUserFrozenRows + input.numSystemRows,
      nonFooterCount,
    );

    const { layout } = SheetLayoutSpec.make<string>({
      cellLayout,
      timescale: "week",
      maxHeight: input.maxHeaderHeight,
      numFrozenRowsSource: { numFrozen: numFrozenSource },
      numSystemRows: input.numSystemRows,
      calculateFrozenRows: () => ({
        numFrozen: numFrozenSource,
        numFrozenFlattened: numFrozenSource,
      }),
      numFooterRowsSource: { numFooter, numFooterFlattened: numFooter },
      flattenedRows,
    });

    const numFrozen = layout.numFrozenRowsLayout.numFrozenFlattened;
    const numFooterLayout = layout.numFooterRowsLayout.numFooterFlattened;
    const total = flattenedRows.length;

    return {
      numFrozenFlattened: numFrozen,
      numFooterFlattened: numFooterLayout,
      noOverlap: numFrozen + numFooterLayout <= total,
    };
  },
  (result, expected, caseName) => {
    assertEquals(result.numFrozenFlattened, expected.numFrozenFlattened, `${caseName}: numFrozenFlattened`);
    assertEquals(result.numFooterFlattened, expected.numFooterFlattened, `${caseName}: numFooterFlattened`);
    assertEquals(result.noOverlap, expected.noOverlap, `${caseName}: frozen+footer must not overlap`);
  },
);
