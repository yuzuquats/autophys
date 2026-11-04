import "../icon-button";
import "../icons/sheets-icon";
import "../sidebar/sidebar-expand-button";
import "./rail";
import "./rail-nav";

import { Column } from "../../component-builtin";
import { LonaIcons, PlusIcon } from "../../ui/icons";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { IconButton } from "../icon-button";
import { SheetsIcon } from "../icons/sheets-icon";
import { SidebarExpandButton } from "../sidebar/sidebar-expand-button";
import { Rail } from "./rail";
import { RailNav } from "./rail-nav";
import { RailStoryBook } from "./rail.example";

// The core card for std-rail. The first example is written for the card: a
// workspace rail at a width that fits a ~380px card, with the three things an
// owner brings to it — a head action, a nav body and the expand button that
// lives OUTSIDE the rail, because a rail collapsed to zero has nowhere to hold
// its own. Everything after it is the Sidebar tab's RailStoryBook, reused as
// is: those cards already cover the collapse modes, the scroll shadows, the
// drag floor, the headless rail and the frame-hosted case, and a second copy
// here would drift from them.

const CARD_HEIGHT_PX = 400;

/** Narrower than RailStoryBook's 300px default so the rail and a strip of
 * content both fit in one core card. The prefix is the card's own, so a drag
 * here never restores into the Sidebar tab's rails. */
const WORKSPACE: Rail.Width = {
  kind: "owned",
  defaultPx: 240,
  minPx: 200,
  maxPx: 300,
  storagePrefix: "std-rail-core-storybook",
  collapsedWidthPx: 0,
};

/** The page the rail stands in: a plain flex row, because the rail's owned
 * width is a flex-basis and needs a flex parent to mean anything. */
function $frame(): HTMLElement {
  const $box = document.createElement("div");
  $box.assignStyles({
    display: "flex",
    height: `${CARD_HEIGHT_PX}px`,
    width: "380px",
    maxWidth: "100%",
    border: "1px solid var(--divider)",
    borderRadius: "8px",
    overflow: "hidden",
    background: "var(--bg)",
  });
  return $box;
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

function $sheetIcon(): HTMLElement {
  return SheetsIcon.makeWith({ size: 16 });
}

function $workspaceNav(onSelect: (key: string, label: string) => void): RailNav {
  const sections: RailNav.Section[] = [
    {
      title: "Sheets",
      count: 4,
      rows: [
        { key: "sheets/roadmap", label: "Q4 roadmap", $icon: $sheetIcon() },
        { key: "sheets/hiring", label: "Hiring pipeline", $icon: $sheetIcon() },
        { key: "sheets/travel", label: "Travel 2026", $icon: $sheetIcon() },
        { key: "sheets/budget", label: "Household budget", $icon: $sheetIcon() },
      ],
    },
    {
      title: "Calendars",
      count: 3,
      rows: [
        { key: "cal/work", label: "Work", $icon: $swatch("var(--blue)") },
        { key: "cal/personal", label: "Personal", $icon: $swatch("var(--green)") },
        { key: "cal/holidays", label: "Holidays", $icon: $swatch("var(--orange)") },
      ],
    },
  ];
  const labels = new Map(
    sections.flatMap((s) => s.rows.map((r) => [r.key, r.label] as const)),
  );
  const $nav = RailNav.makeWith({
    sections,
    // The nav routes the click out; the owner decides and selects back in.
    onSelect: (key) => {
      $nav.select(key);
      onSelect(key, labels.get(key) ?? key);
    },
  });
  // Centre the glyphs on the label rather than on the row's top edge.
  $nav.style.setProperty("--cell-align", "center");
  return $nav;
}

function $foot(text: string): HTMLElement {
  const $f = Column.make();
  $f.slot = "foot";
  // The rows' text edge: the body's 16px plus the inset every row carries.
  $f.style.padding = "10px calc(16px + var(--rail-inset, 8px)) 12px";
  $f.style.borderTop = "1px solid var(--divider)";
  const $t = Typography.small(text);
  $t.assignStyles({
    color: "var(--text-ter)",
    marginTop: "0px",
    marginBottom: "0px",
  });
  $f.append($t);
  return $f;
}

export class CoreRailStoryBook extends Storybook.Default {
  title(): string {
    return "Rail";
  }

  tags(): string[] {
    return ["std-rail"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "A workspace rail — drag the edge, collapse from the page",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Q4 roadmap is open");

          const $rail = Rail.make();
          $rail.bind({
            title: "Workspace",
            count: null,
            width: WORKSPACE,
            onCollapsedChange: (collapsed) => {
              $status.bindText(collapsed ? "Rail collapsed" : "Rail open");
            },
            onWidthChange: (px) => {
              $status.bindText(`Rail width ${px}px`);
            },
          });

          // A head action is any element slotted into `head-actions`; the
          // rail only gives it the head's trailing edge.
          const $add = IconButton.makeWith({
            content: LonaIcons.$svg(PlusIcon),
            squarish: true,
            ariaLabel: "New sheet",
          });
          $add.slot = "head-actions";
          $add.addPointerEvent({
            onClick: () => {
              $status.bindText("New sheet requested");
            },
          });

          const $pageTitle = Typography.h4("Q4 roadmap");
          const $nav = $workspaceNav((_key, label) => {
            $pageTitle.textContent = label;
            $status.bindText(`${label} is open`);
          });
          $nav.select("sheets/roadmap");
          $rail.append($add, $nav, $foot("Synced a minute ago"));

          // The expand button is the page's, not the rail's: a zero-width
          // rail cannot hold the control that brings it back.
          const $expand = SidebarExpandButton.make();
          $expand.style.setProperty("--icon-primary-color", "var(--text-sec)");
          $expand.toggleAttribute("revealed", true);
          $expand.onToggleExpanded = (expanded) => {
            $rail.setCollapsed(!expanded, true);
          };

          const $page = Column.make();
          $page.assignStyles({
            display: "flex",
            flexDirection: "column",
            alignItems: "start",
            flex: "1",
            minWidth: "0",
            padding: "12px 16px",
            gap: "8px",
          });
          $page.append($expand, $pageTitle);

          const $box = $frame();
          $box.append($rail, $page);
          return { $content: $box, $status };
        },
      },
      ...new RailStoryBook().examples(),
    ];
  }
}
