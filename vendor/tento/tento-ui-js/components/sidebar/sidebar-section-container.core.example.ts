import "../icons/card-icon";
import "../icons/sheets-icon";
import "../icons/tasks-icon";
import "../list/list";
import "./sidebar-action-bar";
import "./sidebar-section";
import "./sidebar-section-container";

import { Column } from "../../component-builtin";
import { LonaWebComponent } from "../../component";
import { Storybook } from "../../ui/storybook";
import { LonaCardIcon } from "../icons/card-icon";
import { SheetsIcon } from "../icons/sheets-icon";
import { TasksIcon } from "../icons/tasks-icon";
import { List } from "../list/list";
import { SidebarActionBar } from "./sidebar-action-bar";
import { SidebarSection } from "./sidebar-section";
import { SidebarSectionContainer } from "./sidebar-section-container";

// The core card for std-sidebar-section-container: the column of sidebar
// sections that can focus ONE of them. Focusing slides the target to the top
// and gives it the full height while its siblings fade away; unfocusing brings
// them back. The container owns that motion and nothing else — which section
// is focused, and what changes on it (the back button, here), is the owner's,
// handed in as the `bind` callback so the container can measure before and
// after it.
//
// Every card is a 300 × 380 sidebar, so a focused section has a height to
// fill and an unfocused column has somewhere to scroll.

const WIDTH_PX = 300;
const HEIGHT_PX = 380;

function $frame(): HTMLElement {
  const $col = Column.make();
  $col.assignStyles({
    position: "relative",
    width: `${WIDTH_PX}px`,
    maxWidth: "100%",
    height: `${HEIGHT_PX}px`,
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

type SectionSpec = {
  id: string;
  label: string;
  $icon: () => LonaWebComponent;
  rows: string[];
};

const HOME: SectionSpec = {
  id: "home",
  label: "Home",
  $icon: () => LonaCardIcon.make(),
  rows: ["Today", "This week"],
};

const SHEETS: SectionSpec = {
  id: "sheets",
  label: "Sheets",
  $icon: () => SheetsIcon.make(),
  rows: [
    "Q4 roadmap",
    "Hiring pipeline",
    "Travel 2026",
    "Household budget",
    "Reading list",
    "Weekly review",
  ],
};

const TASKS: SectionSpec = {
  id: "tasks",
  label: "Tasks",
  $icon: () => TasksIcon.make(),
  rows: ["Book flights", "Send the roadmap", "Renew passport"],
};

/** A sidebar of `specs`, wired the way an owner wires it: a header click
 * focuses its section, the back button returns, and the back button is the
 * state flipped inside `bind`. `onFocus` hears the result. */
function $sidebar(
  specs: SectionSpec[],
  onFocus: (id: Option<string>) => void,
): {
  $container: SidebarSectionContainer;
  focus: (id: Option<string>) => void;
} {
  const $container = SidebarSectionContainer.make();
  const sections = new Map<string, SidebarSection>();

  const focus = (id: Option<string>) => {
    const $target = id == null ? $container.$focusedSection : sections.get(id);
    if ($target == null) return;
    $container.focusOnSection(id != null, $target, () => {
      for (const [key, $s] of sections) $s.toggleBackButton(key === id);
    });
    onFocus(id);
  };

  for (const spec of specs) {
    const $section = SidebarSection.makeWithContent(
      spec.label,
      spec.$icon(),
      $rows(spec.rows),
      {
        onNavContentClick: () => focus(spec.id),
        onBackButtonClick: () => focus(null),
      },
    );
    sections.set(spec.id, $section);
    $container.append($section);
  }
  return { $container, focus };
}

function $status(text: string): Storybook.Card.StatusLine {
  const $s = Storybook.Card.StatusLine.make();
  $s.bindText(text);
  return $s;
}

export class CoreSidebarSectionContainerStoryBook extends Storybook.Default {
  title(): string {
    return "Sidebar Section Container";
  }

  tags(): string[] {
    return ["std-sidebar-section-container"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Click a section's name to focus it; back returns",
        render: () => {
          const $said = $status("All sections");
          const { $container } = $sidebar([HOME, SHEETS, TASKS], (id) => {
            $said.bindText(id == null ? "All sections" : `Focused ${id}`);
          });
          const $box = $frame();
          $box.append($container);
          return { $content: $box, $status: $said };
        },
      },
      {
        title: "Switching sections from the action bar",
        render: () => {
          // Lona's arrangement: once a section is focused its siblings are
          // gone, so the way to the next one is the action bar floating at
          // the foot — slotted into the container's `floating` slot and
          // revealed only while something is focused.
          const $bar = SidebarActionBar.make();
          $bar.slot = "floating";
          $bar.assignStyles({ position: "absolute", left: "0px", bottom: "8px" });

          const { $container, focus } = $sidebar(
            [HOME, SHEETS, TASKS],
            (id) => {
              $bar.toggleReveal(id != null, true);
              if (id != null) $bar.setSelected(id);
            },
          );
          $bar.bind({
            actions: [HOME, SHEETS, TASKS].map((spec) => ({
              id: spec.id,
              $icon: spec.$icon(),
              onClick: () => focus(spec.id),
            })),
          });
          $container.append($bar);

          const $box = $frame();
          $box.append($container);
          return $box;
        },
      },
      {
        title: "A column taller than the sidebar scrolls as one",
        render: () => {
          // Five sections overflow 380px. Focusing one from part-way down
          // still lifts it to the top, and unfocusing restores the column.
          const $said = $status("Scroll, then focus a section");
          const { $container } = $sidebar(
            [
              HOME,
              SHEETS,
              TASKS,
              {
                id: "templates",
                label: "Templates",
                $icon: () => LonaCardIcon.make(),
                rows: ["Weekly planner", "Trip itinerary", "Habit tracker"],
              },
              {
                id: "archive",
                label: "Archive",
                $icon: () => SheetsIcon.make(),
                rows: ["Q3 roadmap", "Travel 2025", "Old budget"],
              },
            ],
            (id) => {
              $said.bindText(id == null ? "All sections" : `Focused ${id}`);
            },
          );
          const $box = $frame();
          $box.append($container);
          return { $content: $box, $status: $said };
        },
      },
    ];
  }
}
