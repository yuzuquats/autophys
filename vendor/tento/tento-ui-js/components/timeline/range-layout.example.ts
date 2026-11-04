import { RangeLayout } from "@tento-core/range-layout";
import { Storybook } from "../../ui/storybook";

type Item = {
  id: string;
  range: { start: number; end: number };
  label: string;
  color: string;
  heightUnits?: number;
};

const COLORS = [
  "var(--blue)",
  "var(--green)",
  "var(--purple)",
  "var(--orange)",
  "var(--teal)",
  "var(--red)",
];

const CELL_W = 44;
const CELL_H = 28;
const PAD = 2;

function makeManager(
  maxRows: number,
  defaultVisible: number,
): RangeLayout.Manager<Item> {
  return new RangeLayout.Manager<Item>({
    maxRows,
    defaultVisibleRows: defaultVisible,
    getHeightUnits: (item) => item.heightUnits ?? 1,
  });
}

function renderGrid(
  manager: RangeLayout.Manager<Item>,
  items: Item[],
  colCount: number,
): HTMLElement {
  manager.update(items);
  const partition = manager.partition();

  const totalRows = manager.visibleRows;

  const container = document.createElement("div");
  container.style.cssText = `
    position: relative;
    width: ${colCount * CELL_W}px;
    height: ${totalRows * CELL_H}px;
    background: var(--bg-surface-light, #f8f8f8);
    border: 1px solid var(--divider, #e0e0e0);
    border-radius: 4px;
    font-family: monospace;
    font-size: 10px;
  `;

  for (let r = 0; r <= totalRows; r++) {
    const line = document.createElement("div");
    line.style.cssText = `
      position: absolute;
      left: 0; right: 0;
      top: ${r * CELL_H}px;
      height: 1px;
      background: var(--divider, #e0e0e0);
    `;
    container.appendChild(line);
  }

  for (let c = 0; c <= colCount; c++) {
    const line = document.createElement("div");
    line.style.cssText = `
      position: absolute;
      top: 0; bottom: 0;
      left: ${c * CELL_W}px;
      width: 1px;
      background: var(--divider, #e0e0e0);
    `;
    container.appendChild(line);
  }

  for (const { item, row, heightUnits } of partition.visible) {
    const spanCols = item.range.end - item.range.start + 1;
    const block = document.createElement("div");
    block.style.cssText = `
      position: absolute;
      left: ${item.range.start * CELL_W + PAD}px;
      top: ${row * CELL_H + PAD}px;
      width: ${spanCols * CELL_W - PAD * 2}px;
      height: ${heightUnits * CELL_H - PAD * 2}px;
      background: ${item.color};
      border-radius: 3px;
      display: flex;
      align-items: center;
      padding-left: 4px;
      color: white;
      overflow: hidden;
      white-space: nowrap;
      box-sizing: border-box;
    `;
    block.textContent = item.label;
    container.appendChild(block);
  }

  // Overflow dot per column that has hidden items
  const seen = new Set<number>();
  for (const [point] of partition.overflow) {
    if (seen.has(point)) continue;
    seen.add(point);
    const dot = document.createElement("div");
    dot.style.cssText = `
      position: absolute;
      left: ${point * CELL_W + CELL_W / 2 - 3}px;
      bottom: ${PAD + 2}px;
      width: 6px;
      height: 6px;
      background: var(--text-ter, #aaa);
      border-radius: 50%;
    `;
    container.appendChild(dot);
  }

  return container;
}

function statusLines(
  manager: RangeLayout.Manager<Item>,
  partition: RangeLayout.PartitionResult<Item>,
): string[] {
  const lines: string[] = [
    `visibleRows: ${manager.visibleRows}  maxOccupied: ${manager.maxOccupiedRows.get()}  expanded: ${manager.expanded}`,
    `visible: ${partition.visible.length}  overflowPoints: ${partition.overflow.size}`,
  ];
  for (const { item, row, heightUnits } of partition.visible) {
    lines.push(`  ${item.id}  cols ${item.range.start}–${item.range.end}  row=${row}  h=${heightUnits}`);
  }
  return lines;
}

export class RangeLayoutStoryBook extends Storybook.Default {
  title(): string {
    return "RangeLayout";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Single-row packing (collapsed)",
        render: () => {
          const items: Item[] = [
            { id: "a", range: { start: 0, end: 2 }, label: "A (0–2)", color: COLORS[0] },
            { id: "b", range: { start: 1, end: 3 }, label: "B (1–3)", color: COLORS[1] },
            { id: "c", range: { start: 4, end: 6 }, label: "C (4–6)", color: COLORS[2] },
            { id: "d", range: { start: 0, end: 0 }, label: "D (0)", color: COLORS[3] },
          ];
          const manager = makeManager(4, 1);
          manager.update(items);
          const partition = manager.partition();
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText(statusLines(manager, partition));
          return { $content: renderGrid(manager, items, 8), $status };
        },
      },
      {
        title: "Expanded view",
        render: () => {
          const items: Item[] = [
            { id: "a", range: { start: 0, end: 2 }, label: "A (0–2)", color: COLORS[0] },
            { id: "b", range: { start: 1, end: 3 }, label: "B (1–3)", color: COLORS[1] },
            { id: "c", range: { start: 0, end: 1 }, label: "C (0–1)", color: COLORS[2] },
            { id: "d", range: { start: 2, end: 4 }, label: "D (2–4)", color: COLORS[3] },
          ];
          const manager = makeManager(4, 1);
          manager.update(items);
          manager.partition(); // compute maxOccupiedRows first
          manager.setExpanded(true);
          const partition = manager.partition();
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText(statusLines(manager, partition));
          return { $content: renderGrid(manager, items, 8), $status };
        },
      },
      {
        title: "Height units (tall spans)",
        render: () => {
          const items: Item[] = [
            { id: "a", range: { start: 0, end: 3 }, label: "A tall (2u)", color: COLORS[0], heightUnits: 2 },
            { id: "b", range: { start: 0, end: 1 }, label: "B (1u)", color: COLORS[1] },
            { id: "c", range: { start: 2, end: 4 }, label: "C (1u)", color: COLORS[2] },
            { id: "d", range: { start: 0, end: 4 }, label: "D tall (2u)", color: COLORS[3], heightUnits: 2 },
          ];
          const manager = makeManager(6, 4);
          manager.update(items);
          const partition = manager.partition();
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText(statusLines(manager, partition));
          return { $content: renderGrid(manager, items, 8), $status };
        },
      },
      {
        title: "Overflow with more-dots",
        render: () => {
          const items: Item[] = Array.from({ length: 8 }, (_, i) => ({
            id: `ev${i}`,
            range: { start: 0, end: 6 },
            label: `Event ${i}`,
            color: COLORS[i % COLORS.length],
          }));
          const manager = makeManager(4, 1);
          manager.update(items);
          const partition = manager.partition();
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText(statusLines(manager, partition));
          return { $content: renderGrid(manager, items, 8), $status };
        },
      },
      {
        title: "Incremental update (add + remove + resize)",
        render: () => {
          const initialItems: Item[] = [
            { id: "a", range: { start: 0, end: 2 }, label: "A", color: COLORS[0] },
            { id: "b", range: { start: 1, end: 3 }, label: "B", color: COLORS[1] },
            { id: "c", range: { start: 4, end: 6 }, label: "C", color: COLORS[2] },
          ];
          const manager = makeManager(4, 3);
          manager.update(initialItems);
          manager.partition();

          const updatedItems: Item[] = [
            { id: "a", range: { start: 0, end: 4 }, label: "A (extended)", color: COLORS[0] },
            { id: "c", range: { start: 4, end: 6 }, label: "C", color: COLORS[2] },
            { id: "d", range: { start: 2, end: 5 }, label: "D (new)", color: COLORS[3] },
          ];
          manager.update(updatedItems);
          const partition = manager.partition();
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText([
            "After update: B removed, A extended to 0–4, D added.",
            ...statusLines(manager, partition),
          ]);
          return { $content: renderGrid(manager, updatedItems, 8), $status };
        },
      },
    ];
  }
}
