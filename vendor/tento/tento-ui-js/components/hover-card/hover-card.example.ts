import "../avatar";

import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { LinkText } from "../link-text/link-text";
import { HoverCard } from "./hover-card";

function $profile(): HTMLElement {
  const $c = Column.make();
  $c.style.gap = "6px";
  $c.style.minWidth = "200px";
  $c.appendChild(Typography.p("James Kao"));
  $c.appendChild(Typography.small("Operator · lona-inc"));
  $c.appendChild(LinkText.makeWith({ href: "#lib:core", text: "Profile", external: false, onClick: null, tone: null }));
  return $c;
}

/** The card only exists while hovered, so the example is its trigger. */
function $trigger(): HTMLElement {
  const $a = LinkText.makeWith({ href: "#lib:core", text: "@james (hover me)", external: false, onClick: (e) => e.preventDefault(), tone: null });
  $a.appendChild(HoverCard.makeWith({ $content: $profile, openDelayMs: null, closeDelayMs: null, placement: null }));
  return $a;
}

export class HoverCardStoryBook extends Storybook.Default {
  title(): string {
    return "Hover Card";
  }

  tags(): string[] {
    return ["std-hover-card"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Profile card on a mention", render: () => $trigger() },
    ];
  }
}
