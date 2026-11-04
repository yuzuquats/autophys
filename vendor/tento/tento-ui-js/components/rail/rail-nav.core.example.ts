import "../icons/sheets-icon";
import "../list/list";
import "./rail-nav";

import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { SheetsIcon } from "../icons/sheets-icon";
import { RailNav } from "./rail-nav";
import { RailNavStoryBook } from "./rail-nav.example";

// The core card for std-rail-nav. RailNavStoryBook (rail-nav.example.ts)
// already covers the assembly's rules — untitled groups, zero counts, a shared
// selection, an unwired nav, the 340px docs width — and is reused after the
// two examples written here. Those two show what it does not: rows carrying
// an icon and an accessory, and a rebind that keeps the selection the route
// chose, the `clear → build → apply` contract a live list depends on.
//
// Every card routes the click OUT and selects back IN, as a real body does.

const COLUMN_WIDTH_PX = 260;

function $column(): HTMLElement {
  const $col = Column.make();
  $col.assignStyles({
    // Centre row glyphs on the label rather than on the row's top edge.
    "--cell-align": "center",
    width: `${COLUMN_WIDTH_PX}px`,
    boxSizing: "border-box",
    padding: "12px 16px",
    border: "1px solid var(--divider)",
    borderRadius: "8px",
    background: "var(--bg)",
  });
  return $col;
}

function $sheetIcon(): HTMLElement {
  return SheetsIcon.makeWith({ size: 16 });
}

/** A dot in a calendar's colour, the glyph the calendar rows lead with. */
function $swatch(color: string): HTMLElement {
  const $dot = document.createElement("div");
  $dot.style.width = "10px";
  $dot.style.height = "10px";
  $dot.style.borderRadius = "50%";
  $dot.style.background = color;
  return $dot;
}

/** A quiet trailing figure — today's events on a calendar row. */
function $tally(n: number): HTMLElement {
  const $t = Typography.small(String(n));
  $t.assignStyles({
    color: "var(--text-ter)",
    marginTop: "0px",
    marginBottom: "0px",
    fontVariantNumeric: "tabular-nums",
  });
  return $t;
}

function $status(text: string): Storybook.Card.StatusLine {
  const $s = Storybook.Card.StatusLine.make();
  $s.bindText(text);
  return $s;
}

export class CoreRailNavStoryBook extends Storybook.Default {
  title(): string {
    return "Rail Nav";
  }

  tags(): string[] {
    return ["std-rail-nav"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Sheets and calendars, with icons and counts",
        render: () => {
          const $routed = $status("Showing Q4 roadmap");
          const $nav = RailNav.makeWith({
            sections: [
              {
                title: "Sheets",
                count: 3,
                rows: [
                  ["sheets/roadmap", "Q4 roadmap"],
                  ["sheets/hiring", "Hiring pipeline"],
                  ["sheets/travel", "Travel 2026"],
                ].map(([key, label]) => ({ key, label, $icon: $sheetIcon() })),
              },
              {
                title: "Calendars",
                count: 3,
                rows: [
                  {
                    key: "cal/work",
                    label: "Work",
                    $icon: $swatch("var(--blue)"),
                    $accessory: $tally(4),
                  },
                  {
                    key: "cal/personal",
                    label: "Personal",
                    $icon: $swatch("var(--green)"),
                    $accessory: $tally(1),
                  },
                  {
                    key: "cal/holidays",
                    label: "Holidays",
                    $icon: $swatch("var(--orange)"),
                  },
                ],
              },
            ],
            // The route resolves first; only then does the row light.
            onSelect: (key) => {
              $nav.select(key);
              $routed.bindText(`Routed to ${key}`);
            },
          });
          $nav.select("sheets/roadmap");

          const $col = $column();
          $col.append($nav);
          return { $content: $col, $status: $routed };
        },
      },
      {
        title: "Rebinding keeps the selection the route chose",
        render: () => {
          // A sheet list that grows while one sheet is open. Each bind clears
          // the rows' refs and keeps the key, so the open sheet stays lit
          // across every rebuild without the owner re-selecting it.
          const sheets = ["Q4 roadmap", "Hiring pipeline"];
          const $routed = $status("Hiring pipeline is open");
          const $nav = RailNav.make();
          const bind = () => {
            $nav.bind({
              sections: [
                {
                  title: "Sheets",
                  count: sheets.length,
                  rows: sheets.map((label) => ({
                    key: label,
                    label,
                    $icon: $sheetIcon(),
                  })),
                },
              ],
              onSelect: (key) => {
                $nav.select(key);
                $routed.bindText(`${key} is open`);
              },
            });
          };
          bind();
          $nav.select("Hiring pipeline");

          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Add a sheet", {
              type: "secondary",
              onClick: () => {
                sheets.push(`Untitled ${sheets.length - 1}`);
                bind();
              },
            }),
            Button.makeWith("Close sheet", {
              type: "flat",
              onClick: () => {
                $nav.select(null);
                $routed.bindText("No sheet open");
              },
            }),
          );

          const $col = $column();
          $col.append($nav);
          return { $content: $col, $controls, $status: $routed };
        },
      },
      ...new RailNavStoryBook().examples(),
    ];
  }
}
