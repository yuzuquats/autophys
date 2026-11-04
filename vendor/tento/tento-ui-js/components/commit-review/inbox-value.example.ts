import { Storybook } from "../../ui/storybook";
import { faceFor } from "./agent-face";
import { InboxValue } from "./inbox-value";

// Storybook for the inbox's field-column cell. One string in, right-aligned
// tabular text out — the card stacks several cells in one fixed-width
// column so the right-edge alignment (the reason the cell exists) is the
// thing on display.

/** A column of values at the drafts column's shipped width. The empty
 * string renders the dim middot placeholder that keeps a column open. */
function $column(values: string[], width: number): HTMLElement {
  const $col = document.createElement("div");
  $col.style.display = "flex";
  $col.style.flexDirection = "column";
  $col.style.gap = "8px";
  $col.style.width = `${width}px`;
  $col.style.padding = "6px 8px";
  for (const v of values) {
    const $cell = InboxValue.make();
    $cell.bind(v);
    $col.appendChild($cell);
  }
  return $col;
}

export class InboxValueStoryBook extends Storybook.Default {
  title(): string {
    return "InboxValue (std-review-inbox-value)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Counts — tabular figures, read by their right edge",
        render: () => $column(["3", "12", "1", ""], 58),
      },
      {
        title: "Agent glyphs — ◆ assigned, ● watched, ○ recent commit, · nothing",
        render: () => $column(["◆", "●", "○", ""], 58),
      },
      {
        title: "Agent faces — the mark says which harness, the ring says it is working",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Live claude, idle codex, a harness we ship no mark for (initials), " +
        // "and an assignment whose job named nobody — which keeps the plain ◆ " +
        // "rather than inventing an identity.",
        render: () => {
          const $col = document.createElement("div");
          $col.style.display = "flex";
          $col.style.flexDirection = "column";
          $col.style.gap = "8px";
          $col.style.width = "58px";
          $col.style.padding = "6px 8px";
          const cases: [string, boolean][] = [
            ["claude", true],
            ["codex", false],
            ["opencode", false],
          ];
          for (const [engine, active] of cases) {
            const face = faceFor(engine);
            if (face == null) continue;
            const $cell = InboxValue.make();
            $cell.bindAgent(face, active, () => {});
            $col.appendChild($cell);
          }
          // The null-engine fallback, bound the way the inbox binds it.
          const $unknown = InboxValue.make();
          $unknown.bindAction("◆", () => {});
          $col.appendChild($unknown);
          return $col;
        },
      },
      {
        title: "Action face — the assigned glyph is a door; hover brightens",
        render: () => {
          const $col = document.createElement("div");
          $col.style.display = "flex";
          $col.style.flexDirection = "column";
          $col.style.gap = "8px";
          $col.style.width = "58px";
          $col.style.padding = "6px 8px";
          const $cell = InboxValue.make();
          let opens = 0;
          const $count = InboxValue.make();
          $count.bind("");
          $cell.bindAction("◆", () => {
            opens += 1;
            $count.bind(`${opens}×`);
          });
          $col.append($cell, $count);
          return $col;
        },
      },
      {
        title: "Ages — mixed units still align",
        render: () => $column(["now", "12m", "5h", "3d"], 46),
      },
    ];
  }
}
