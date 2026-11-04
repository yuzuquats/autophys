import "../kbd/kbd";

import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Kbd } from "../kbd/kbd";
import { Tooltip } from "./tooltip";

/** The tooltip is invisible until its trigger is hovered or focused, so each
 * example is the trigger with the tooltip inside it. */
function $trigger(label: string, tip: Tooltip): HTMLElement {
  const $b = Button.makeWith(label, { type: "secondary", onClick: () => {} });
  $b.appendChild(tip);
  return $b;
}

function $rich(): HTMLElement {
  const $tip = Tooltip.makeWith({ text: "Toggle sidebar", placement: "right", delayMs: null });
  $tip.appendChild(Kbd.makeWith({ keys: ["cmd", "\\"], platform: "mac" }));
  return $trigger("Rich content", $tip);
}

export class TooltipStoryBook extends Storybook.Default {
  title(): string {
    return "Tooltip";
  }

  tags(): string[] {
    return ["std-tooltip"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Top (hover or focus the button)", render: () => $trigger("Hover me", Tooltip.makeWith({ text: "Saves the draft", placement: "top", delayMs: null })) },
      { title: "Bottom", render: () => $trigger("Below", Tooltip.makeWith({ text: "Opens the details", placement: "bottom", delayMs: null })) },
      { title: "Left", render: () => $trigger("Left", Tooltip.makeWith({ text: "Use suggested category", placement: "left", delayMs: null })) },
      { title: "Right, no delay", render: () => $trigger("Right", Tooltip.makeWith({ text: "Immediate", placement: "right", delayMs: 0 })) },
      { title: "Slotted content", render: () => $rich() },
      { title: "Long text wraps at the max width", render: () => $trigger("Long", Tooltip.makeWith({ text: "A description long enough to wrap: the bubble grows to its max width and then breaks lines, and never leaves the viewport.", placement: "top", delayMs: null })) },
    ];
  }
}
