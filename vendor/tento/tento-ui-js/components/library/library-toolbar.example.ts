import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { LibraryToolbar } from "./library-toolbar";

// The kit's own card also fills the `search` slot, with the spotlight twin the
// toolbar reveals once a hero has scrolled away. That half stayed on rwc-03
// with `std-library-search-mount`, so this card shows the two regions that came
// over: the leading title and the trailing actions, at rest and scrolled.
export class LibraryToolbarStoryBook extends Storybook.Default {
  title(): string {
    return "Library toolbar";
  }

  tags(): string[] {
    return ["std-library-toolbar"];
  }

  examples(): Storybook.Example[] {
    return [320, 800].flatMap((width) =>
      [false, true].map((scrolled) => ({
        title: `${width}px · ${scrolled ? "scrolled — the divider is lit" : "at rest"}`,
        render: () => {
          const $toolbar = LibraryToolbar.make().bind({ scrolled, searchVisible: false });
          // At most the card's width: a toolbar wider than its frame would
          // run past the card instead of showing how it lays out.
          $toolbar.style.width = `${width}px`;
          $toolbar.style.maxWidth = "100%";
          // Sticky pins to the review page's viewport, so in a card the bar
          // would ride over the cards below it; here it stays in its place.
          $toolbar.style.position = "relative";
          const $title = Typography.p("Library");
          $title.slot = "leading";
          const $action = Button.makeWith("New", { type: "flat", onClick: () => {} });
          $action.slot = "actions";
          $toolbar.append($title, $action);
          return $toolbar;
        },
      })),
    );
  }
}
