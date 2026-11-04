import { Button } from "../button/button";
import { Chip } from "../chip/chip";
import { ChipRow } from "../chip/chip-row";
import { MenuBar } from "../menu-bar/menu-bar";
import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";

import { Card } from "./card";

// A standalone 1:1 swatch so the examples don't depend on network images.
function $swatch(from: string, to: string): HTMLElement {
  const $el = document.createElement("div");
  $el.style.width = "100%";
  $el.style.aspectRatio = "1 / 1";
  $el.style.background = `linear-gradient(135deg, ${from}, ${to})`;
  return $el;
}

function $menubar($children: HTMLElement[]): HTMLElement {
  const $bar = MenuBar.makeWith({ label: null, rule: false });
  $bar.slot = "menubar";
  for (const $child of $children) {
    $child.slot = "start";
    $bar.appendChild($child);
  }
  return $bar;
}

function $chips(chips: Chip.ViewModel[]): HTMLElement {
  const $row = ChipRow.makeWith(chips);
  $row.slot = "chips";
  return $row;
}

function $column($card: HTMLElement): HTMLElement {
  const $root = Column.make();
  $root.assignStyles({ width: "min(360px, 100%)", padding: "24px" });
  $root.appendChild($card);
  return $root;
}

export class CardStoryBook extends Storybook.Default {
  title(): string {
    return "Card";
  }

  tags(): string[] {
    return ["std-card"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () => {
          const $card = Card.makeWith({
            title: "lib-12345 · Acme Co.",
            subtitle: "Strong - bold headline, clear CTA",
            score: "Score 0.82",
            accent: null,
            selected: false,
            onHeaderClick: null,
          });
          $card.appendChild(
            $menubar([Button.makeWith("Open details", { type: "flat", onClick: () => {} })]),
          );
          $card.appendChild($swatch("var(--blue)", "var(--purple)"));
          return $column($card);
        },
      },
      {
        title: "Chips",
        render: () => {
          const $card = Card.makeWith({
            title: "lib-12345 · Acme Co.",
            subtitle: "Strong - bold headline, clear CTA",
            score: "Score 0.82",
            accent: null,
            selected: false,
            onHeaderClick: null,
          });
          $card.appendChild(
            $chips([
              { label: "webp", tone: "neutral" },
              { label: "decompose v2", tone: "done" },
              { label: "analysis v2", tone: "done" },
            ]),
          );
          $card.appendChild(
            $menubar([Button.makeWith("Open details", { type: "flat", onClick: () => {} })]),
          );
          $card.appendChild($swatch("var(--blue)", "var(--purple)"));
          return $column($card);
        },
      },
      {
        title: "Positive",
        render: () => {
          const $card = Card.makeWith({
            title: "col-0003 · Meadow",
            subtitle: "adjacent +15° · f0.71 sp1.11",
            score: null,
            accent: "positive",
            selected: false,
            onHeaderClick: null,
          });
          $card.appendChild($swatch("var(--green)", "var(--teal)"));
          return $column($card);
        },
      },
      {
        title: "Interactive header — the whole header opens the card",
        render: () => {
          const $card = Card.makeWith({
            title: "lib-12345 · Acme Co.",
            subtitle: "Hover it, or tab to it and press Enter",
            score: "Score 0.82",
            accent: null,
            selected: false,
            onHeaderClick: () => {},
          });
          $card.appendChild(
            $chips([{ label: "decompose v2", tone: "done" }]),
          );
          $card.appendChild($swatch("var(--blue)", "var(--purple)"));
          return $column($card);
        },
      },
      {
        title: "Selected",
        render: () => {
          const $card = Card.makeWith({
            title: "ad-09 · Calendar hero",
            subtitle: null,
            score: null,
            accent: null,
            selected: true,
            onHeaderClick: null,
          });
          $card.appendChild($swatch("var(--orange)", "var(--red)"));
          return $column($card);
        },
      },
    ];
  }
}
