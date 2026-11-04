import { Column } from "../../component-builtin";
import { Position } from "../../anchor-positioning-utils";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { Popover } from "./popover";

/** A popover is nothing until revealed, so each example is the trigger that
 * reveals it; the popover itself is what appears. */
function $trigger(label: string, props: Omit<Popover.Props, "$content">, $content: () => HTMLElement): HTMLElement {
  const $btn = Button.makeWith(label, {
    type: "secondary",
    onClick: () => {
      Popover.show({ ...props, $content, $anchor: $btn });
    },
  });
  return $btn;
}

function $dialogContent(): HTMLElement {
  const $c = Column.make();
  $c.style.gap = "8px";
  $c.appendChild(Typography.p("Discard the draft?"));
  $c.appendChild(Button.makeWith("Discard", { type: "destructive", onClick: () => {} }));
  return $c;
}

function $cardContent(): HTMLElement {
  const $c = Column.make();
  $c.appendChild(Typography.p("A passive card: no role, focus lands on the popover itself."));
  return $c;
}

export class PopoverStoryBook extends Storybook.Default {
  title(): string {
    return "Popover";
  }

  tags(): string[] {
    return ["std-popover"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Dialog below, with arrow (click, then Escape — focus returns)", render: () => $trigger("Open dialog", { role: "dialog", label: "Discard draft", placement: null, arrow: true, onDismiss: null }, $dialogContent) },
      { title: "Passive card to the right", render: () => $trigger("Open card", { role: "none", label: null, placement: Position.RIGHT_CENTER, arrow: false, onDismiss: null }, $cardContent) },
      { title: "Above", render: () => $trigger("Open above", { role: "none", label: null, placement: Position.TOP_CENTER, arrow: false, onDismiss: null }, $cardContent) },
    ];
  }
}
