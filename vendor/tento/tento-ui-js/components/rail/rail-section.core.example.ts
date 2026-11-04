import "../list/list";
import "./rail-section";

import { Column, Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { List } from "../list/list";
import { RailSection } from "./rail-section";
import { RailSectionStoryBook } from "./rail-section.example";

// The core card for std-rail-section. The Sidebar tab's RailSectionStoryBook
// already makes the case for the label register — three sections under one
// selection, the empty section, the suppressed zero, the long title, the meta
// slot — so the card leads with its first example and reuses the rest as is.
// What it adds is the two calls that book never makes: `setCount` on a
// section that re-counts without re-titling, and the `--rail-section-case`
// opt-out for a rail whose groups are names rather than furniture.

const COLUMN_WIDTH_PX = 240;

/** A rail-width column, the same 240px RailSectionStoryBook pins its cards to,
 * so the cards added here read at the width the reused ones do. */
function $column(): HTMLElement {
  const $col = Column.make();
  $col.assignStyles({
    width: `${COLUMN_WIDTH_PX}px`,
    boxSizing: "border-box",
    padding: "12px 16px",
    border: "1px solid var(--divider)",
    borderRadius: "8px",
    background: "var(--bg)",
  });
  return $col;
}

function $rows(labels: string[]): HTMLElement {
  let builder = List.builder();
  for (const label of labels) {
    builder = builder.row(label);
  }
  const $list = builder.build();
  $list.style.setProperty("--list-cell-layout-hover-color", "var(--bg-hover)");
  return $list;
}

export class CoreRailSectionStoryBook extends Storybook.Default {
  title(): string {
    return "Rail Section";
  }

  tags(): string[] {
    return ["std-rail-section"];
  }

  examples(): Storybook.Example[] {
    const [lead, ...rest] = new RailSectionStoryBook().examples();
    return [
      lead,
      {
        title: "Re-counting in place with setCount",
        render: () => {
          // A task inbox: the count changes on every add and clear, the title
          // never does, so the section is bound once and re-counted after.
          const tasks = ["Book flights", "Send Q4 roadmap", "Renew passport"];
          const $list = Column.make();
          const $section = RailSection.makeWith(
            { title: "Inbox", count: tasks.length },
            $list,
          );
          const render = () => {
            $list.replaceChildren($rows(tasks));
            // Zero is suppressed: the empty list already says "nothing here".
            $section.setCount(tasks.length);
          };
          render();

          const $col = $column();
          $col.append($section);

          const $controls = Row.make();
          $controls.style.gap = "8px";
          $controls.append(
            Button.makeWith("Add task", {
              type: "secondary",
              onClick: () => {
                tasks.push(`Follow up ${tasks.length + 1}`);
                render();
              },
            }),
            Button.makeWith("Clear all", {
              type: "flat",
              onClick: () => {
                tasks.length = 0;
                render();
              },
            }),
          );
          return { $content: $col, $controls };
        },
      },
      {
        title: "Sentence-case group names for an outline",
        render: () => {
          // `--rail-section-case: none` keeps the label's size, weight and
          // ink and drops only the uppercase — for groups that are the
          // document's own headings rather than the rail's furniture.
          const $col = $column();
          $col.style.setProperty("--rail-section-case", "none");
          $col.style.setProperty("--rail-section-tracking", "0px");
          $col.append(
            RailSection.makeWith(
              { title: "Trip to Lisbon", count: null },
              $rows(["Flights", "Where we're staying", "Day-by-day plan"]),
            ),
            RailSection.makeWith(
              { title: "Packing", count: 12 },
              $rows(["Clothes", "Documents"]),
            ),
          );
          return $col;
        },
      },
      ...rest,
    ];
  }
}
