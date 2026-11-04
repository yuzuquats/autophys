import "./no-cards-state";

import { Storybook } from "@tento-ui/ui/storybook";
import { Toast } from "@tento-ui/components/toast/toast";
import { NoCardsState } from "./no-cards-state";

function $deckSlot($card: HTMLElement): HTMLElement {
  const $slot = document.createElement("div");
  $slot.style.width = "240px";
  $slot.style.height = "360px";
  $slot.appendChild($card);
  return $slot;
}

const onAddCard = () => Toast.info("Start tracking");

export class NoCardsStateStoryBook extends Storybook.Default {
  title(): string {
    return "No Cards State";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Empty (hero + copy + CTA)",
        render: () =>
          $deckSlot(
            NoCardsState.makeWith({
              title: "Track anything",
              caption: "Habits, tasks, metrics — add a card to follow it here.",
              heroSrc: "illustration/stars",
              heroDecorative: true,
              onAddCard,
            }),
          ),
      },
      {
        title: "All complete (no CTA)",
        render: () =>
          $deckSlot(
            NoCardsState.makeWith({
              title: "All done!",
              caption: null,
              heroSrc: "illustration/checkmark",
              heroDecorative: true,
              onAddCard: null,
            }),
          ),
      },
    ];
  }
}
