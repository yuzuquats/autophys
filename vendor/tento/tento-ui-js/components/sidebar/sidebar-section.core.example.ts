import "../icon-button";
import "../icons/card-icon";
import "../icons/sheets-icon";
import "../icons/tasks-icon";
import "../list/list";
import "./sidebar-section";

import { Column } from "../../component-builtin";
import { LonaIcons, PlusIcon } from "../../ui/icons";
import { Storybook } from "../../ui/storybook";
import { IconButton } from "../icon-button";
import { LonaCardIcon } from "../icons/card-icon";
import { SheetsIcon } from "../icons/sheets-icon";
import { TasksIcon } from "../icons/tasks-icon";
import { List } from "../list/list";
import { SidebarSection } from "./sidebar-section";

// The core card for std-sidebar-section: one block of a Lona-style sidebar.
// A section is a sticky std-sidebar-section-nav over whatever body the owner
// slots in, padded 12px, scrolling on its own with the scrollbar hidden, and
// ruled off from the next section by an inset divider that hides once the
// section is focused (`expanded`) or asked to (`hide-bottom-border`).
//
// Every card is a 300px column — the sidebar's resting width — and the cards
// that scroll pin a height, because the section is `height: 100%` of whatever
// holds it and a card that shrink-wraps would never show the overflow.

const WIDTH_PX = 300;

function $frame(heightPx: Option<number> = null): HTMLElement {
  const $col = Column.make();
  $col.assignStyles({
    width: `${WIDTH_PX}px`,
    maxWidth: "100%",
    height: heightPx == null ? "" : `${heightPx}px`,
    border: "1px solid var(--divider)",
    borderRadius: "8px",
    overflow: "hidden",
    background: "var(--bg)",
  });
  return $col;
}

function $rows(labels: string[]): List {
  let builder = List.builder();
  for (const label of labels) {
    builder = builder.row(label);
  }
  const $list = builder.build();
  $list.style.setProperty("--list-cell-layout-hover-color", "var(--bg-hover)");
  return $list;
}

function $plusButton(label: string): IconButton {
  return IconButton.makeWith({
    content: LonaIcons.$svg(PlusIcon),
    squarish: true,
    ariaLabel: label,
  });
}

const SHEETS = ["Q4 roadmap", "Hiring pipeline", "Travel 2026", "Household budget"];
const TASKS = ["Book flights", "Send the roadmap", "Renew passport"];

export class CoreSidebarSectionStoryBook extends Storybook.Default {
  title(): string {
    return "Sidebar Section";
  }

  tags(): string[] {
    return ["std-sidebar-section"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Sheets — a header, an add button and the list",
        render: () => {
          const $said = Storybook.Card.StatusLine.make();
          $said.bindText("Click “Sheets” to focus it");

          // The owner runs the focus: the section only draws it.
          const focus = (focused: boolean) => {
            $section.toggleBackButton(focused);
            $section.toggleAttribute("expanded", focused);
            $said.bindText(focused ? "Sheets focused" : "All sections");
          };
          const $section = SidebarSection.makeWithContent(
            "Sheets",
            SheetsIcon.make(),
            $rows(SHEETS),
            {
              onNavContentClick: () => focus(true),
              onBackButtonClick: () => focus(false),
            },
          );
          $section.$nav.bindAccessory({
            $element: $plusButton("New sheet"),
            onClick: () => {
              $said.bindText("New sheet requested");
            },
          });

          const $box = $frame();
          $box.append($section);
          return { $content: $box, $status: $said };
        },
      },
      {
        title: "Stacked sections, ruled apart",
        render: () => {
          const $home = SidebarSection.makeWithContent(
            "Home",
            LonaCardIcon.make(),
            $rows(["Today", "This week"]),
          );
          const $sheets = SidebarSection.makeWithContent(
            "Sheets",
            SheetsIcon.make(),
            $rows(SHEETS.slice(0, 2)),
          );
          const $tasks = SidebarSection.makeWithContent(
            "Tasks",
            TasksIcon.make(),
            $rows(TASKS),
          );
          // The last block has nothing under it to be ruled off from.
          $tasks.toggleAttribute("hide-bottom-border", true);

          const $box = $frame();
          $box.append($home, $sheets, $tasks);
          return $box;
        },
      },
      {
        title: "A long list scrolls under a sticky header",
        render: () => {
          const labels = Array.from(
            { length: 24 },
            (_, i) => `Weekly review ${24 - i}`,
          );
          const $section = SidebarSection.makeWithContent(
            "Sheets",
            SheetsIcon.make(),
            $rows(labels),
          );
          $section.toggleAttribute("hide-bottom-border", true);
          // The section scrolls inside its own height, so it has to be given
          // one: a flex item left at its content height never overflows.
          $section.assignStyles({ height: "100%", minHeight: "0px" });

          const $box = $frame(260);
          $box.append($section);
          return $box;
        },
      },
      {
        title: "Focused — back button shown, divider gone",
        render: () => {
          const $section = SidebarSection.makeWithContent(
            "Tasks",
            TasksIcon.make(),
            $rows(TASKS),
            { onBackButtonClick: () => {} },
          );
          $section.$nav.bindAccessory({
            $element: $plusButton("New task"),
            onClick: () => {},
          });
          $section.toggleBackButton(true);
          $section.toggleAttribute("expanded", true);

          const $box = $frame();
          $box.append($section);
          return $box;
        },
      },
      {
        title: "Raw contents — no header at all",
        render: () => {
          // `makeWithRawContents` never binds the nav, so the header stays
          // `display: none` and the body starts at the section's own padding.
          const $section = SidebarSection.makeWithRawContents(
            $rows(["Settings", "Help and feedback", "Sign out"]),
          );
          $section.toggleAttribute("hide-bottom-border", true);

          const $box = $frame();
          $box.append($section);
          return $box;
        },
      },
    ];
  }
}
