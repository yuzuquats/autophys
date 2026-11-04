import "../token/token";

import { Storybook } from "../../ui/storybook";
import { Token } from "../token/token";
import { OverflowList } from "./overflow-list";

const TAGS = ["design-system", "accessibility", "performance", "consistency", "catalogue", "charter", "review", "astryx", "tier-1", "overflow"];

function $list(width: string): OverflowList {
  const $l = OverflowList.makeWith({
    items: TAGS.map((t) => ({ id: t, label: t, onSelect: null, $render: () => Token.makeWith({ label: t, removable: false, onRemove: null, tone: null }) })),
    overflowLabel: null,
  });
  $l.style.maxWidth = width;
  return $l;
}

export class OverflowListStoryBook extends Storybook.Default {
  title(): string {
    return "Overflow List";
  }

  tags(): string[] {
    return ["std-overflow-list"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Ten tokens in 360px — the tail becomes a menu", render: () => $list("360px") },
      { title: "Wide enough for all", render: () => $list("100%") },
    ];
  }
}
