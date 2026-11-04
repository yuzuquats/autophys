import "../list/list";
import "./rail-nav";

import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { RailNav } from "./rail-nav";
import { SelectionSync } from "./selection-sync";

// The cards are 240px columns — the admin board's width, the narrowest in the
// survey — for the reason the section cards are: the assembly has to read at
// the narrow end, and a card as wide as the storybook would only ever show
// the easy case.
//
// Every card drives the component the way a real body does: the click routes
// OUT to a handler, the handler decides, and only then does `select` come
// back in. That round trip is the thing most worth seeing, because it is the
// part each hand-rolled copy got wrong in a different way.

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

function $note(text: string): HTMLElement {
  const $p = Typography.p(text);
  $p.assignStyles({
    "--font-size": "var(--small-size)",
    color: "var(--text-ter)",
    margin: "8px 0 0",
    padding: "0 12px",
  });
  return $p;
}

export class RailNavStoryBook extends Storybook.Default {
  title(): string {
    return "RailNav (std-rail-nav)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "The admin board's nav, entire",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "One untitled section over four routes. This is the whole of " +
        // "admin-nav now: a route table and a bind. Clicking routes out and " +
        // "the handler selects back in, which is why the row lights.",
        render: () => {
          const $col = $column();
          const $nav = RailNav.makeWith({
            sections: [{
              rows: [
                { key: "/_/admin", label: "Dashboard" },
                { key: "/_/admin/logs", label: "Logs" },
                { key: "/_/admin/routes", label: "Routes" },
                { key: "/_/admin/ux-tests", label: "UX Tests" },
              ],
            }],
            onSelect: (key) => $nav.select(key),
          });
          $nav.select("/_/admin");
          $col.appendChild($nav);
          return $col;
        },
      },
      {
        title: "Titled groups, and a count",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Sections carry std-rail-section's label register and its inset, " +
        // "so the header sits on the rows' own text edge with no negative " +
        // "margin anywhere. A count of 0 is omitted, not drawn.",
        render: () => {
          const $col = $column();
          const $nav = RailNav.makeWith({
            sections: [
              {
                title: "Components",
                count: 3,
                rows: [
                  { key: "accordion", label: "Accordion" },
                  { key: "list", label: "List" },
                  { key: "rail", label: "Rail" },
                ],
              },
              {
                title: "Drafts",
                count: 0,
                rows: [{ key: "drafts/none", label: "Nothing yet" }],
              },
            ],
            onSelect: (key) => $nav.select(key),
          });
          $nav.select("list");
          $col.appendChild($nav);
          return $col;
        },
      },
      {
        title: "An untitled group above titled ones",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "A section with no title draws no header at all rather than an " +
        // "empty one — the case a library with no grouping hits. Without it " +
        // "that library sat 18px lower than its neighbours.",
        render: () => {
          const $col = $column();
          const $nav = RailNav.makeWith({
            sections: [
              { rows: [{ key: "overview", label: "Overview" }] },
              {
                title: "Guides",
                rows: [
                  { key: "guides/start", label: "Getting started" },
                  { key: "guides/deploy", label: "Deploying" },
                ],
              },
            ],
            onSelect: (key) => $nav.select(key),
          });
          $nav.select("overview");
          $col.appendChild($nav);
          return $col;
        },
      },
      {
        title: "Two navs, one selection",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "docs-nav's case: a nav per library inside an accordion, and only " +
        // "one row in the column may be lit. The caller passes its own " +
        // "SelectionSync and owns the clear; selecting in the lower nav " +
        // "darkens the upper one.",
        render: () => {
          const $col = $column();
          const selection = new SelectionSync<string>();
          const select = (key: string): void => selection.select(key);

          const $first = RailNav.makeWith({
            selection,
            onSelect: select,
            sections: [{
              title: "@tento-ui",
              rows: [
                { key: "ui/accordion", label: "Accordion" },
                { key: "ui/list", label: "List" },
              ],
            }],
          });
          const $second = RailNav.makeWith({
            selection,
            onSelect: select,
            sections: [{
              title: "lona-console",
              rows: [
                { key: "console/sheets", label: "Sheets" },
                { key: "console/rows", label: "Rows" },
              ],
            }],
          });
          selection.select("ui/list");

          $col.appendChild($first);
          $col.appendChild($second);
          $col.appendChild(
            $note("One map across both navs — click either side."),
          );
          return $col;
        },
      },
      {
        title: "A click that routes nowhere still does not light",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "onSelect omitted: the rows are inert by construction. The nav " +
        // "never selects on click, so a body whose routing is not wired yet " +
        // "shows nothing rather than a selection the URL disagrees with.",
        render: () => {
          const $col = $column();
          $col.appendChild(
            RailNav.makeWith({
              sections: [{
                title: "Not wired",
                rows: [
                  { key: "a", label: "Clicking me does nothing" },
                  { key: "b", label: "Nor me" },
                ],
              }],
            }),
          );
          $col.appendChild(
            $note("No onSelect, no selection — deliberately."),
          );
          return $col;
        },
      },
      {
        title: "At 340px, the docs width",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The same assembly at the widest surface in the survey. The label " +
        // "register and the row inset are unchanged; only the column grows.",
        render: () => {
          const $col = $column(340);
          const $nav = RailNav.makeWith({
            sections: [{
              title: "Components",
              count: 12,
              rows: [
                { key: "wide/accordion", label: "Accordion" },
                {
                  key: "wide/long",
                  label: "A navigation label long enough to reach the edge",
                },
                { key: "wide/list", label: "List" },
              ],
            }],
            onSelect: (key) => $nav.select(key),
          });
          $nav.select("wide/long");
          $col.appendChild($nav);
          return $col;
        },
      },
    ];
  }
}
