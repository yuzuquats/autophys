import "../icons/card-icon";
import "../icons/pomodoro-icon";
import "../icons/search-icon";
import "../icons/sheets-icon";
import "../icons/tasks-icon";
import "./sidebar-action-bar";

import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { LonaCardIcon } from "../icons/card-icon";
import { LonaPomodoroIcon } from "../icons/pomodoro-icon";
import { LonaSearchIcon } from "../icons/search-icon";
import { SheetsIcon } from "../icons/sheets-icon";
import { TasksIcon } from "../icons/tasks-icon";
import { SidebarActionBar } from "./sidebar-action-bar";

// The core card for std-sidebar-action-bar: the floating strip of section
// glyphs at the foot of Lona's sidebar. It is invisible and inert until the
// owner reveals it — Lona does so while a section is focused, when the other
// sections have faded and the bar is the way across to them. A click lights
// its action and then calls out; the owner can also move the light itself
// with `setSelected`, as Lona does when a section is focused some other way.
//
// Every card reveals the bar except the one about revealing, because a bar
// left at its default draws nothing at all.

const WIDTH = "300px";

/** Lona's five actions, in Lona's order, each reporting to `onAction`. */
function lonaActions(onAction: (id: string) => void): SidebarActionBar.Action[] {
  const actions: [string, HTMLElement][] = [
    ["home", LonaCardIcon.make()],
    ["search", LonaSearchIcon.make()],
    ["sheets", SheetsIcon.make()],
    ["tasks", TasksIcon.make()],
    ["pomodoro", LonaPomodoroIcon.make()],
  ];
  return actions.map(([id, $icon]) => ({
    id,
    $icon,
    onClick: () => onAction(id),
  }));
}

function $revealed(props: SidebarActionBar.Props): SidebarActionBar {
  const $bar = SidebarActionBar.make();
  $bar.bind(props);
  $bar.toggleReveal(true, false);
  return $bar.assignStyles({ width: WIDTH, maxWidth: "100%" });
}

function $status(text: string): Storybook.Card.StatusLine {
  const $s = Storybook.Card.StatusLine.make();
  $s.bindText(text);
  return $s;
}

export class CoreSidebarActionBarStoryBook extends Storybook.Default {
  title(): string {
    return "Sidebar Action Bar";
  }

  tags(): string[] {
    return ["std-sidebar-action-bar"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Lona's section switcher, Sheets selected",
        render: () => {
          const $said = $status("Sheets is open");
          const $bar = $revealed({
            actions: lonaActions((id) => {
              $said.bindText(`Clicked ${id}`);
            }),
            selectedId: "sheets",
          });
          return { $content: $bar, $status: $said };
        },
      },
      {
        title: "Hidden until a section is focused",
        render: () => {
          // A stand-in sidebar with the bar pinned to its foot, as Lona
          // places it. Bound but not revealed, it is transparent and inert —
          // not clickable, not tabbable — until the owner reveals it.
          const $sidebar = Column.make();
          $sidebar.assignStyles({
            position: "relative",
            width: WIDTH,
            maxWidth: "100%",
            height: "220px",
            padding: "12px",
            boxSizing: "border-box",
            border: "1px solid var(--divider)",
            borderRadius: "8px",
            background: "var(--bg)",
          });
          $sidebar.append(Typography.h4("Sheets"));

          const $bar = SidebarActionBar.make();
          $bar.bind({ actions: lonaActions(() => {}), selectedId: "sheets" });
          $bar.assignStyles({ position: "absolute", left: "0px", bottom: "8px" });
          $sidebar.append($bar);

          let revealed = false;
          const $toggle = Button.makeWith("Focus Sheets", {
            type: "secondary",
            onClick: () => {
              revealed = !revealed;
              $bar.toggleReveal(revealed, true);
              $toggle.textContent = revealed ? "Back to all" : "Focus Sheets";
            },
          });
          const $controls = Storybook.Card.Controls.make();
          $controls.append($toggle);
          return { $content: $sidebar, $controls };
        },
      },
      {
        title: "The owner moves the selection with setSelected",
        render: () => {
          const $bar = $revealed({
            actions: lonaActions(() => {}),
            selectedId: "home",
          });
          // Focusing a section from its own header, not from the bar, still
          // has to light that section here — so the owner says so.
          const $controls = Storybook.Card.Controls.make();
          for (const [label, id] of [
            ["Home", "home"],
            ["Sheets", "sheets"],
            ["Tasks", "tasks"],
          ] as const) {
            $controls.append(
              Button.makeWith(label, {
                type: "flat",
                onClick: () => $bar.setSelected(id),
              }),
            );
          }
          return { $content: $bar, $controls };
        },
      },
      {
        title: "Two actions, nothing selected yet",
        render: () =>
          $revealed({
            actions: [
              { id: "sheets", $icon: SheetsIcon.make() },
              { id: "tasks", $icon: TasksIcon.make() },
            ],
            selectedId: null,
          }),
      },
    ];
  }
}
