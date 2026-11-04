import "../list/list";
import "./rail-section";

import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { List } from "../list/list";
import { RailSection } from "./rail-section";
import { SelectionSync } from "./selection-sync";

// Every card is a rail-width column — 240px, the narrowest surface in the
// survey (the admin board) — because the label register has to read at 240px
// AND at 340px, and a card as wide as the storybook would never show the
// narrow case. The label is a std-list-cell-layout like the rows under it,
// set in the same --p-size: weight and ink are what separate a section's
// title from its rows, not size or case.

const COLUMN_WIDTH_PX = 240;

function $column(widthPx: number = COLUMN_WIDTH_PX): HTMLElement {
  const $col = Column.make();
  $col.style.width = `${widthPx}px`;
  $col.style.boxSizing = "border-box";
  $col.style.padding = "12px 16px";
  $col.style.border = "1px solid var(--divider)";
  $col.style.borderRadius = "8px";
  $col.style.background = "var(--bg)";
  return $col;
}

/** A `std-list` of the given labels, every row registered with `selection`
 * and clicking through to it — the wiring every body in the kit uses. */
function $rows(
  labels: string[],
  selection: SelectionSync<string>,
  onSelect: (label: string) => void,
): HTMLElement {
  let builder = List.builder();
  for (const label of labels) {
    builder = builder.row(label, {
      ref: selection.ref(label),
      pointerEvents: { onClick: () => onSelect(label) },
    });
  }
  const $list = builder.build();
  // The selected band is inset by the preview column's padding, so it reads as a chip
  // rather than a full-bleed stripe.
  $list.style.setProperty("--list-cell-layout-hover-color", "var(--bg-hover)");
  $list.style.setProperty(
    "--list-cell-selected-background-color",
    "var(--bg-surface-light)",
  );
  return $list;
}

export class RailSectionStoryBook extends Storybook.Default {
  title(): string {
    return "RailSection (std-rail-section)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Three sections, one selection",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The docs-nav shape: labelled groups of rows under one selection. " +
        // "Click any row — the page would navigate and call back in; here the " +
        // "card calls `select` directly. The label and the rows share " +
        // "`--rail-inset`, so it sits flush over the row text with no " +
        // "negative margin on the list. Sections separate by whitespace, not " +
        // "rules.",
        render: () => {
          const $col = $column();
          const selection = new SelectionSync<string>();
          const select = (label: string) => selection.select(label);
          $col.append(
            RailSection.makeWith(
              { title: "Getting started", count: 3 },
              $rows(["Install", "First run", "Concepts"], selection, select),
            ),
            RailSection.makeWith(
              { title: "Components", count: 4 },
              $rows(["Accordion", "List", "Rail", "Section head"], selection, select),
            ),
            RailSection.makeWith(
              { title: "Reference", count: null },
              $rows(["CLI", "Config"], selection, select),
            ),
          );
          selection.select("Rail");
          return $col;
        },
      },
      {
        title: "An empty section",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "A label over nothing. The section never self-hides: the region " +
        // "exists and is empty, which is a different fact from the region not " +
        // "existing, and a hole where a header was cannot be told from a " +
        // "failed render. A body that wants a group gone removes the section.",
        render: () => {
          const $col = $column();
          const selection = new SelectionSync<string>();
          $col.append(
            RailSection.makeWith(
              { title: "Recent", count: null },
              $rows(["Yesterday's run", "The parser"], selection, () => {}),
            ),
            RailSection.makeWith({ title: "Pinned", count: null }),
            RailSection.makeWith(
              { title: "Archived", count: 1 },
              $rows(["June"], selection, () => {}),
            ),
          );
          return $col;
        },
      },
      {
        title: "Count 0, count null, count 12",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Zero is suppressed, not drawn. A lone `0` beside a label reads as " +
        // "a failed fetch, and the region's empty state already says there is " +
        // "nothing here. So the first two labels render identically, and only " +
        // "the third carries a number.",
        render: () => {
          const $col = $column();
          const selection = new SelectionSync<string>();
          $col.append(
            RailSection.makeWith({ title: "Count zero", count: 0 }),
            RailSection.makeWith({ title: "Count null", count: null }),
            RailSection.makeWith(
              { title: "Count twelve", count: 12 },
              $rows(["One row of twelve"], selection, () => {}),
            ),
          );
          return $col;
        },
      },
      {
        title: "A long title beside a count, at 240px",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "What gives when the label does not fit: the label, which wraps, " +
        // "and never the count, which is `flex: none` in tabular figures so " +
        // "it stays put while the words fold. The same label at 340px on the " +
        // "right is the widest surface in the survey — one register, read at " +
        // "both widths.",
        render: () => {
          const $pair = document.createElement("div");
          $pair.style.display = "flex";
          $pair.style.gap = "16px";
          $pair.style.alignItems = "flex-start";
          for (const width of [240, 340]) {
            const $col = $column(width);
            const selection = new SelectionSync<string>();
            $col.append(
              RailSection.makeWith(
                { title: "Checkout, guest and returning parity", count: 128 },
                $rows(["Guest", "Returning"], selection, () => {}),
              ),
            );
            $pair.append($col);
          }
          return $pair;
        },
      },
      {
        title: "The meta slot",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Whatever the owner wants at the far edge — a filter, a reload, a " +
        // "unit — arrives through a named slot and stays in the owner's light " +
        // "DOM under the owner's own stylesheet. The default is quiet and " +
        // "small; the caller overrides it normally.",
        render: () => {
          const $col = $column();
          const selection = new SelectionSync<string>();
          const $meta = Typography.small("failing first");
          $meta.slot = "meta";
          const $section = RailSection.makeWith(
            { title: "Groups", count: 9 },
            $meta,
            $rows(["cart", "catalog", "checkout"], selection, () => {}),
          );
          $col.append($section);
          selection.select("catalog");
          return $col;
        },
      },
    ];
  }
}
