import { Storybook } from "../../ui/storybook";
import { ReviewRail } from "./review-rail";

// Storybook for the commit-review subsidebar's frame — the first time any of
// it has been reviewable without booting the whole review app.
//
// The rail is a full-height flex child of a row, so every card fixes a height
// and lays the rail out the way `#layout` does. The body is stand-in content,
// not a real log: what these cards are for is the FRAME — the sticky title,
// the two-word view switch, the 52px collapse, and the panel takeover.
//
// One thing the cards deliberately cannot show: the rail's preferences are
// real `localStorage` reads, so a card renders in whatever collapse and view
// state the operator last left the app in. Each card therefore asserts the
// state it wants rather than trusting the default.

/** Stand-in body: enough rows to overflow, so the scroll shadows engage. */
function $rows(count: number): HTMLElement {
  const $col = document.createElement("div");
  $col.style.display = "flex";
  $col.style.flexDirection = "column";
  $col.style.gap = "10px";
  $col.style.padding = "10px 16px";
  for (let i = 0; i < count; i += 1) {
    const $row = document.createElement("div");
    $row.style.display = "flex";
    $row.style.alignItems = "center";
    $row.style.gap = "10px";
    const $dot = document.createElement("div");
    $dot.style.width = "12px";
    $dot.style.height = "12px";
    $dot.style.flexShrink = "0";
    $dot.style.borderRadius = "50%";
    $dot.style.background = i % 3 === 0 ? "var(--yellow)" : "var(--divider)";
    const $label = document.createElement("div");
    $label.style.font = "12.5px/1.5 system-ui, sans-serif";
    $label.style.color = "var(--text-sec)";
    $label.style.whiteSpace = "nowrap";
    $label.textContent = `draft ${i + 1} — a subject long enough to clip`;
    $row.append($dot, $label);
    $col.appendChild($row);
  }
  return $col;
}

/** The rail in the layout it actually ships in: a fixed-height flex row. */
function $mounted(configure: (rail: ReviewRail) => void): HTMLElement {
  const $layout = document.createElement("div");
  $layout.style.display = "flex";
  $layout.style.height = "360px";
  $layout.style.border = "1px solid var(--divider)";
  $layout.style.borderRadius = "8px";
  $layout.style.overflow = "hidden";

  const $rail = ReviewRail.make();
  $rail.appendChild($rows(14));
  configure($rail);

  const $pane = document.createElement("div");
  $pane.style.flex = "1";
  $pane.style.minWidth = "0";
  $pane.style.padding = "14px";
  $pane.style.font = "12px system-ui, sans-serif";
  $pane.style.color = "var(--text-ter)";
  $pane.textContent = "the pane";

  $layout.append($rail, $pane);
  return $layout;
}

export class ReviewRailStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewRail (review-rail)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Stack view — 300px, sticky title, scroll shadows",
        render: () =>
          $mounted((rail) => {
            rail.setCollapsed(false, false);
            rail.setView("stack", false);
          }),
      },
      {
        title: "Collapsed — 52px, the graph lane and nothing else",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Rows keep their full 300px layout and are clipped rather than " +
        // "reflowed: a rewrap mid-animation reads as a glitch. The divider " +
        // "handle hides — a 52px strip is a state, not a size.",
        render: () =>
          $mounted((rail) => {
            rail.setView("stack", false);
            rail.setCollapsed(true, false);
          }),
      },
      {
        title: "Inbox view — the body swaps, and so does the head",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The flat/nodes toggle and the repo tabs are stack-view furniture " +
        // "(the inbox spans repos), so they give way to the columns button. " +
        // "Three buttons in either view, and neither carries the other's.",
        render: () =>
          $mounted((rail) => {
            rail.setCollapsed(false, false);
            rail.setView("inbox", false);
          }),
      },
      {
        title: "Panel — the rail given over to one subject",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "lona.so's sidebar-modal shape: the panel REPLACES the body and " +
        // "widens the rail to 400px, so the thing you opened and the place " +
        // "you opened it from are one column. Closing restores the width you " +
        // "had, not the default. The rail's own width eases between the two; " +
        // "the list and the card do not — both are pinned to a definite " +
        // "width first, so the moving edge reveals them rather than " +
        // "reflowing them frame by frame.",
        render: () => {
          const $content = document.createElement("div");
          $content.style.flex = "1";
          $content.style.display = "grid";
          $content.style.placeItems = "center";
          $content.style.font = "12px system-ui, sans-serif";
          $content.style.color = "var(--text-ter)";
          $content.textContent = "the agent thread (an iframe, in the app)";
          return $mounted((rail) => {
            rail.setCollapsed(false, false);
            rail.setView("stack", false);
            rail.showPanel({ title: "agent · L-341", $content, widthPx: 400 });
          });
        },
      },
    ];
  }
}
