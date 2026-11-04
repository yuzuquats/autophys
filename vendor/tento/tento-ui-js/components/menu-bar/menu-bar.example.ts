import { Button } from "../button/button";
import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";

import { MenuBar } from "./menu-bar";

function $frame($child: HTMLElement): HTMLElement {
  const $root = Column.make();
  $root.assignStyles({ width: "min(420px, 100%)", padding: "24px" });
  $root.appendChild($child);
  return $root;
}

// Controls are slotted individually — a slot is display:contents, so each one
// becomes a flex item of the bar and picks up its alignment and gap. Wrapping
// them in a row would opt out of both.
function $slotted(slot: "start" | "end", $children: HTMLElement[]): HTMLElement[] {
  for (const $child of $children) $child.slot = slot;
  return $children;
}

function $flat(label: string): HTMLElement {
  return Button.makeWith(label, { type: "flat", onClick: () => {} });
}

export class MenuBarStoryBook extends Storybook.Default {
  title(): string {
    return "Menu Bar";
  }

  tags(): string[] {
    return ["std-menu-bar"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "One action",
        render: () => {
          const $bar = MenuBar.makeWith({ label: null, rule: false });
          $bar.append(...$slotted("start", [$flat("Open details")]));
          return $frame($bar);
        },
      },
      {
        title: "Both edges",
        render: () => {
          const $bar = MenuBar.makeWith({ label: "Creative actions", rule: true });
          $bar.style.setProperty("--menu-bar-padding", "12px 2px");
          $bar.append(
            ...$slotted("start", [Typography.p("Sort", "small"), $flat("Ranking")]),
          );
          $bar.append(...$slotted("end", [$flat("Refresh"), $flat("Export")]));
          return $frame($bar);
        },
      },
      {
        title: "Trailing",
        render: () => {
          const $bar = MenuBar.makeWith({ label: null, rule: false });
          $bar.append(...$slotted("end", [$flat("Cancel"), $flat("Save")]));
          return $frame($bar);
        },
      },
    ];
  }
}
