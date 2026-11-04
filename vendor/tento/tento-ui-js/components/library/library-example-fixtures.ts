import "../grid/grid-layout";
import "../spotlight/spotlight-layout";

import { Typography } from "../../ui/typography";
import { GridLayout } from "../grid/grid-layout";
import { Round } from "../round";
import { SpotlightLayout } from "../spotlight/spotlight-layout";
import { LibrarySearchMount } from "./library-search-mount";

// The pieces the library stories share, built from the components an app
// actually composes — Spotlight, Round cards in a GridLayout — so a card shows
// the layout as Notes and Agent Board render it rather than as bare inputs.
// Styles are inline: a story's cards are light DOM, and a component's $styles
// never reach them.

export namespace LibraryExampleFixtures {
  export type Item = { title: string; body: string; meta: string };

  export const ITEMS: Item[] = [
    { title: "Meeting notes", body: "Agenda, decisions and the three follow-ups nobody owns yet.", meta: "Sep 8 · 212 words" },
    { title: "Reading list", body: "Essays to finish before the weekend.", meta: "Sep 7 · 48 words" },
    { title: "Project outline", body: "The shape of the work, the order it lands in, and what it replaces.", meta: "Sep 5 · 530 words" },
    { title: "Groceries", body: "Oats, lemons, coffee.", meta: "Sep 4 · 6 words" },
  ];

  /** A Spotlight search in its reserved-height mount, calling `onQuery` as
   * the reader types. */
  export function $search(
    placeholder: string,
    onQuery: (text: string) => void,
  ): LibrarySearchMount {
    const $mount = LibrarySearchMount.make();
    $mount.slot = "search";
    SpotlightLayout.make().mountIn($mount, {
      placeholder,
      focusZIndex: 3,
      measureHeight: true,
      onFocus: () => {},
      onBlur: () => {},
      onQuery: (text) => onQuery((text ?? "").toLowerCase().trim()),
      onDismiss: () => {},
    });
    return $mount;
  }

  /** One item as a Round card; `onOpen` makes the whole card the target. */
  export function $card(item: Item, onOpen: Option<() => void>): Round {
    const $card = Round.makeWith({ bg: "var(--bg)", border: "var(--divider)", radius: 12 });
    const $body = document.createElement("div");
    Object.assign($body.style, {
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      padding: "16px",
      cursor: onOpen ? "pointer" : "default",
    });
    const $title = Typography.h3(item.title);
    $title.assignStyles({ "--font-size": "var(--text-12px)", "--margin-top": "0px", "--margin-bottom": "0px" });
    const $excerpt = Typography.p(item.body);
    $excerpt.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", "--line-height-ratio": "1.5", color: "var(--text-sec)" });
    const $meta = Typography.small(item.meta);
    $meta.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", color: "var(--text-ter)" });
    $body.append($title, $excerpt, $meta);
    if (onOpen) {
      $body.tabIndex = 0;
      $body.setAttribute("role", "button");
      $body.setAttribute("aria-label", `Open ${item.title}`);
      $body.onclick = onOpen;
      $body.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      };
    }
    $card.append($body);
    return $card;
  }

  /** The grid Notes uses: 4px gaps, 240px minimum columns. */
  export function $grid(): GridLayout {
    const $grid = GridLayout.make();
    $grid.slot = "items";
    $grid.toggleAttribute("no-transition", true);
    return $grid;
  }

  export function fillGrid(
    $grid: GridLayout,
    items: Item[],
    onOpen: Option<(item: Item) => void>,
  ): void {
    $grid.replaceChildren(
      ...items.map((item) => {
        const $tile = document.createElement("article");
        $tile.append($card(item, onOpen ? () => onOpen(item) : null));
        return $tile;
      }),
    );
    $grid.bind({ blockSpacingPx: 4, inlineSpacingPx: 4, minWidthPx: 240 });
  }

  export function matches(item: Item, query: string): boolean {
    return `${item.title} ${item.body}`.toLowerCase().includes(query);
  }
}
