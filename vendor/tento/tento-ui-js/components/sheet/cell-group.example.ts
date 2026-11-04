import { Storybook } from "@tento-ui/ui/storybook";
import { CellGroup } from "@tento-ui/components/sheet/cell-group";
import { SheetCell } from "@tento-ui/components/sheet/sheet-cell";
import { Typography } from "@tento-ui/ui/typography";
import { naivedate, PartialDate, TimezoneRegion } from "@tento-chrono";
import { ColumnIndex } from "@tento-ui/components/sheet/column-index";

function makeCell(content: string, pd: Option<PartialDate>): SheetCell<any> {
  const $cell = SheetCell.make();
  $cell.cellId = pd
    ? {
        row: "row-id",
        col: new ColumnIndex.Key.Resolved.Default(
          pd,
          TimezoneRegion.UTC,
          0,
          null,
          null,
        ),
      }
    : null;
  $cell.bindContent(
    "number",
    Typography.p(content).assignStyles({
      padding: "12px",
      textAlign: "center",
    }),
  );
  $cell.bindLayoutOptions(
    {
      card: true,
      canDrawCardBorder: false,
      marginInline: "0px",
      marginBlock: "0px",
    },
    false,
  );
  return $cell;
}

export class CellGroupStoryBook extends Storybook.Default {
  title(): string {
    return "CellGroup";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Cell Group",
        render: () => {
          const cells: SheetCell<any>[] = Array.from({ length: 5 }, (_, i) =>
            (Math.random() * 100).toFixed(2),
          ).map((c, i) =>
            makeCell(c, PartialDate.fromDate(naivedate(2024, 1, i + 1))),
          );
          return CellGroup.make().bind(cells, {
            individualCellHeight: 36,
            visibleCellCount: 3,
            seeMoreHeight: 24,
            totalCells: cells.length,
          });
        },
      },
      {
        title: "Cell Group (No Label)",
        render: () => {
          const cells: SheetCell<any>[] = Array.from({ length: 3 }, (_, i) =>
            (Math.random() * 100).toFixed(2),
          ).map((c) => makeCell(c, null));
          return CellGroup.make().bind(cells, {
            individualCellHeight: 36,
            visibleCellCount: 3,
            seeMoreHeight: 24,
            totalCells: cells.length,
          });
        },
      },
      {
        title: "Cell Group (Week)",
        render: () => {
          const cells: SheetCell<any>[] = Array.from({ length: 3 }, (_, i) =>
            (Math.random() * 100).toFixed(2),
          ).map((c, i) => makeCell(c, PartialDate.fromWeek(2024, i + 1)));
          return CellGroup.make().bind(cells, {
            individualCellHeight: 36,
            visibleCellCount: 3,
            seeMoreHeight: 24,
            totalCells: cells.length,
          });
        },
      },
      {
        title: "Cell Group (Month)",
        render: () => {
          const cells: SheetCell<any>[] = Array.from({ length: 3 }, (_, i) =>
            (Math.random() * 100).toFixed(2),
          ).map((c, i) => makeCell(c, PartialDate.fromMonth(2024, i + 1)));
          return CellGroup.make().bind(cells, {
            individualCellHeight: 36,
            visibleCellCount: 3,
            seeMoreHeight: 24,
            totalCells: cells.length,
          });
        },
      },
      {
        title: "Cell Group (Year)",
        render: () => {
          const cells: SheetCell<any>[] = Array.from({ length: 3 }, (_, i) =>
            (Math.random() * 100).toFixed(2),
          ).map((c, i) => makeCell(c, PartialDate.fromYear(2024 + i)));
          return CellGroup.make().bind(cells, {
            individualCellHeight: 36,
            visibleCellCount: 3,
            seeMoreHeight: 24,
            totalCells: cells.length,
          });
        },
      },
    ];
  }
}
