import "../list/list";
import "../shell-layout/shell-layout";
import "./rail";
import "./rail-section";

import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { List } from "../list/list";
import { ShellLayout } from "../shell-layout/shell-layout";
import { Rail } from "./rail";
import { RailSection } from "./rail-section";
import { SelectionSync } from "./selection-sync";

// Every owned card is the rail in a flex row beside an empty content pane,
// because that is the contract: `std-rail` with an owned width is
// `flex: 0 0 var(--rail-w)`, and the pane is what shows its edge — and its
// collapse — as an edge rather than as the card's own border.
//
// 480px of height, so the body scrolls and the shadows have something to say.
//
// Cards ASSERT the state they want rather than calling `restorePreferences`:
// the review harness shims storage to an in-memory map, and the app's own
// storybook page would otherwise render whatever state the operator last left
// the app in.

const CARD_HEIGHT_PX = 480;

const OWNED: Rail.Width = {
  kind: "owned",
  defaultPx: 300,
  minPx: 220,
  maxPx: 600,
  storagePrefix: "std-rail-storybook",
  collapsedWidthPx: 0,
};

/** The review rail's collapse: a 52px lane instead of nothing. */
const LANE: Rail.Width = { ...OWNED, collapsedWidthPx: 52 };

/** The page a rail stands in. An explicit width, because a storybook card
 * shrink-wraps its content and a rail beside a pane would otherwise be laid
 * out at its min-content width rather than at the width it owns. */
function $frame(widthPx: number = 640): HTMLElement {
  const $box = document.createElement("div");
  $box.style.display = "flex";
  $box.style.height = `${CARD_HEIGHT_PX}px`;
  $box.style.width = `${widthPx}px`;
  $box.style.maxWidth = "100%";
  $box.style.border = "1px solid var(--divider)";
  $box.style.borderRadius = "8px";
  $box.style.overflow = "hidden";
  $box.style.background = "var(--bg)";
  return $box;
}

function $pane(label: string): HTMLElement {
  const $p = document.createElement("div");
  $p.style.flex = "1";
  $p.style.minWidth = "0";
  $p.style.padding = "16px";
  $p.style.font = "12px system-ui, sans-serif";
  $p.style.color = "var(--text-ter)";
  $p.textContent = label;
  return $p;
}

/** `count` rows under `title`, registered with `selection`. */
function $section(
  title: string,
  count: number,
  selection: SelectionSync<string>,
  prefix: string = title.toLowerCase(),
): HTMLElement {
  let builder = List.builder();
  for (let i = 1; i <= count; i++) {
    const key = `${prefix}-${i}`;
    builder = builder.row(`${title} ${i}`, {
      ref: selection.ref(key),
      pointerEvents: { onClick: () => selection.select(key) },
    });
  }
  const $list = builder.build();
  $list.style.setProperty("--list-cell-layout-hover-color", "var(--bg-hover)");
  $list.style.setProperty(
    "--list-cell-selected-background-color",
    "var(--bg-surface-light)",
  );
  return RailSection.makeWith({ title, count }, $list);
}

function $foot(text: string): HTMLElement {
  const $f = Column.make();
  $f.slot = "foot";
  // The rows' text edge: the body's 16px plus the inset every row carries.
  $f.style.padding = "10px calc(16px + var(--rail-inset, 8px)) 12px";
  $f.style.borderTop = "1px solid var(--divider)";
  const $t = Typography.small(text);
  $t.assignStyles({ color: "var(--text-ter)", marginTop: "0px", marginBottom: "0px" });
  $f.append($t);
  return $f;
}

function $ownedRail(options: {
  width?: Rail.Width;
  collapsed?: boolean;
  sections?: [string, number][];
  title?: Option<string>;
}): Rail {
  const $rail = Rail.make();
  $rail.bind({
    title: options.title === undefined ? "Groups" : options.title,
    count: 9,
    width: options.width ?? OWNED,
    onCollapsedChange: null,
    onWidthChange: null,
  });
  const selection = new SelectionSync<string>();
  const sections = options.sections ?? [
    ["Failing", 2],
    ["Never run", 4],
    ["Green", 3],
  ];
  for (const [title, count] of sections) {
    $rail.append($section(title, count, selection));
  }
  $rail.append($foot("26 of 58 never run"));
  selection.select("never run-2");
  if (options.collapsed === true) $rail.setCollapsed(true, false);
  return $rail;
}

export class RailStoryBook extends Storybook.Default {
  title(): string {
    return "Rail (std-rail)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Owned width: 300px, drag the edge",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The rail in a flex row, owning its width. Drag the trailing edge " +
        // "between 220 and 600px; double-click resets. The head is a section " +
        // "label in docs-nav's register, the body is the scrollport with a " +
        // "shadow at each end, the foot is slotted. What the rail does not " +
        // "own is visible too: the rows are sections the owner slotted in, " +
        // "and clicking one moves a selection the owner holds.",
        render: () => {
          const $box = $frame();
          $box.append($ownedRail({}), $pane("content"));
          return $box;
        },
      },
      {
        title: "Collapsed to zero",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The default collapse: no width at all, the contents clipped rather " +
        // "than reflowed, the divider gone with it. A zero-width element has " +
        // "nowhere to hold its own expand affordance, so the owner places the " +
        // "button — here there is none, which is the point of the card.",
        render: () => {
          const $box = $frame();
          $box.append($ownedRail({ collapsed: true }), $pane("content"));
          return $box;
        },
      },
      {
        title: "Collapsed to a 52px lane",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "`collapsedWidthPx: 52` — the review rail's strip, for a body whose " +
        // "leading column survives the clip. These rows have no such column, " +
        // "so what the lane shows is the first 52px of every label: the card " +
        // "argues for the zero default by showing the alternative.",
        render: () => {
          const $box = $frame();
          $box.append(
            $ownedRail({ collapsed: true, width: LANE }),
            $pane("content"),
          );
          return $box;
        },
      },
      {
        title: "200 rows: the shadows",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The body is the only thing that scrolls. Its scrollbar is hidden — " +
        // "a gutter reserves 15px inside a narrow column — and the two " +
        // "gradients are the cue instead: the top one appears once you have " +
        // "scrolled, the bottom one while there is more.",
        render: () => {
          const $box = $frame();
          $box.append(
            $ownedRail({
              sections: [
                ["Alpha", 60],
                ["Beta", 70],
                ["Gamma", 70],
              ],
            }),
            $pane("content"),
          );
          return $box;
        },
      },
      {
        title: "Dragged to the 220px floor",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The rail at its minimum, as a drag leaves it. `min-width: 0` on " +
        // "the host is what makes the floor reachable: a flex item's default " +
        // "`min-width: auto` is its min-content width, which outranks " +
        // "flex-basis, so without it the longest label would quietly refuse " +
        // "to let the drag go below its own width. The labels clip; the " +
        // "column does not push back.",
        render: () => {
          const $box = $frame();
          const $rail = $ownedRail({
            sections: [
              ["Failing", 2],
              ["Checkout, guest and returning parity", 3],
            ],
          });
          $rail.style.setProperty("--rail-w", "220px");
          $box.append($rail, $pane("content"));
          return $box;
        },
      },
      {
        title: "No title: the sections carry the head",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "`title: null` and nothing slotted into `head-actions`, so the head " +
        // "band is not drawn at all — the first section's head is the top of " +
        // "the column. A rail whose body already names its groups needs no " +
        // "second name above them.",
        render: () => {
          const $box = $frame();
          $box.append($ownedRail({ title: null }), $pane("content"));
          return $box;
        },
      },
      {
        title: "Frame-hosted: std-shell-layout owns the width",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "`width: { kind: \"frame\" }`. The shell reserves a 280px column, " +
        // "runs docked / peek / modal, and the rail fills what it is given: no " +
        // "resizer, no divider of its own, and `setCollapsed` is a no-op — " +
        // "whoever owns the width owns the collapse. The shell's nav padding " +
        // "is zeroed so the rail's own insets rule.",
        render: () => {
          const $box = $frame();
          const $shell = ShellLayout.make();
          $shell.style.flex = "1";
          $shell.style.minWidth = "0";
          $shell.style.setProperty("--shell-nav-padding", "0px");
          $shell.bind({
            geometry: {
              sidebarWidthPx: 280,
              mobileBreakpointPx: 0,
              mobileSidebarMarginPx: 24,
            },
            expandButton: null,
          });
          const $rail = Rail.make();
          $rail.slot = "sidebar";
          $rail.bind({
            title: "Docs",
            count: null,
            width: { kind: "frame" },
            onCollapsedChange: null,
            onWidthChange: null,
          });
          const selection = new SelectionSync<string>();
          $rail.append(
            $section("Getting started", 3, selection),
            $section("Components", 5, selection),
          );
          selection.select("components-2");
          const $content = $pane("content");
          $content.slot = "content";
          $shell.append($rail, $content);
          $box.append($shell);
          return $box;
        },
      },
    ];
  }
}
