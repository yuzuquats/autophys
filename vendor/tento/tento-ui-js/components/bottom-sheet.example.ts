import { Storybook } from "@tento-ui/ui/storybook";

import { BottomSheet } from "./bottom-sheet";
import { Button } from "./button/button";
import { Typography } from "../ui/typography";

// A bottom sheet is a VIEWPORT overlay: `position: fixed`, `inset: 0`, painted
// over whatever is on the page. A card cannot show that honestly — the card is
// not the viewport — so each example renders a small stage with its own
// containing block, and the sheet fills the stage instead of the screen.
//
// `contain: layout paint` on the stage is what makes `position: fixed` resolve
// against it rather than the card's document. It is the only line here that is
// staging rather than usage, and it is the line that makes the rest true.

const STAGE = "360px";

function $stage(): HTMLElement {
  const $s = document.createElement("div");
  $s.style.position = "relative";
  $s.style.height = STAGE;
  $s.style.width = "100%";
  $s.style.overflow = "hidden";
  $s.style.borderRadius = "8px";
  $s.style.border = "1px solid var(--divider, #33333322)";
  // Makes `position: fixed` inside resolve against this box.
  $s.style.contain = "layout paint";
  $s.style.background = "var(--bg, transparent)";
  return $s;
}

function $filler(): HTMLElement {
  const $p = Typography.p(
    "The page underneath. A sheet is read against something, and a card with " +
      "nothing behind the scrim cannot show whether the scrim reads as a scrim.",
  );
  $p.style.padding = "16px";
  $p.style.color = "var(--text-ter, #8b8b8b)";
  return $p;
}

function $title(text: string): HTMLElement {
  const $t = Typography.small(text);
  $t.slot = "title";
  $t.style.color = "var(--text-sec, #6b6b6b)";
  return $t;
}

function $body(paras: string[]): HTMLElement[] {
  return paras.map((text) => Typography.small(text));
}

/** A sheet already open, on a stage. Opened without animating: a card should
 *  paint its state, never be caught arriving at it. */
function $sheet(
  titleText: string,
  paras: string[],
  options?: { maxHeight?: number; noGrip?: boolean; danger?: boolean },
): HTMLElement {
  const $s = $stage();
  $s.append($filler());
  const $sheet = BottomSheet.make();
  if (options?.noGrip === true) $sheet.toggleAttribute("no-grip", true);
  if (options?.danger === true) {
    $sheet.style.setProperty(
      "--sheet-border-color",
      "color-mix(in srgb, var(--red) 38%, var(--divider))",
    );
  }
  $sheet.append($title(titleText), ...$body(paras));
  $s.append($sheet);
  // The stage is not in the document when this runs, so the layout force inside
  // `open` is a no-op and the sheet paints at rest — which is what a card wants.
  $sheet.open(options?.maxHeight);
  return $s;
}

export class BottomSheetStoryBook extends Storybook.Default {
  title(): string {
    return "BottomSheet (std-bottom-sheet)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "A short read",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The ordinary case. Grip, title, close, body — and the sheet is only " +
        // "as tall as what is in it, because the height is content-driven up to " +
        // "a cap rather than a fixed panel size.",
        render: () =>
          $sheet("cart-badge-updates", [
            "no app command exists",
            "The cart verbs the app command union carries are add and remove. " +
              "Everything this spec drives is a third.",
          ]),
      },
      {
        title: "A long read, capped",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The bound is the whole guarantee: a sheet grows UPWARD from the " +
        // "bottom edge, so `maxHeight` is the only thing between a long note and " +
        // "whatever sits at the top of the page. Note where the scroll lives — " +
        // "the BODY moves and the grip and title stay put, which is what makes a " +
        // "long note readable rather than a wall that takes the header with it.",
        render: () =>
          $sheet(
            "checkout-declined-card",
            [
              "verification timed out: no confirmation within 20s",
              "The card is refused at the provider and the app never leaves the " +
                "spinner. Reproduced on three of five attempts, always with the " +
                "same test card, and never when the request is replayed by hand — " +
                "which points at the client's retry rather than the provider.",
              "The failing assertion is the one that waits for the basket to " +
                "survive: it does survive, but the error that should name the " +
                "card names the order instead, so the operator reads it as a " +
                "lost purchase.",
              "Next: instrument the retry, not the provider call.",
              "A fifth paragraph, so the cap is doing something visible.",
              "And a sixth.",
            ],
            { maxHeight: 220 },
          ),
      },
      {
        title: "A failure, toned",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Tone is a border colour set by the caller through a custom property, " +
        // "not a variant this component enumerates. A primitive that knows what " +
        // "`danger` means has taken a position on its callers' vocabulary.",
        render: () =>
          $sheet(
            "search-ranking-stable",
            [
              "the same query returned two different orders",
              "Run twice, sixty seconds apart, against an unchanged index.",
            ],
            { danger: true },
          ),
      },
      {
        title: "A long title keeps clear of the close button",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The close button owns the end of the title row, and the row keeps " +
        // "`--sheet-safe-area-inset-end` free for it, so a title too long for " +
        // "the row ellipsizes before the button instead of running under it.",
        render: () =>
          $sheet(
            "checkout-declined-card-after-three-retries-against-the-sandbox-provider-with-the-same-test-card",
            ["verification timed out: no confirmation within 20s"],
          ),
      },
      {
        title: "No title",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The title row is at least as tall as the close button, so a sheet " +
        // "with nothing in the title slot still starts its body below the " +
        // "button. The button stays flat: its scroll shadow is for a button " +
        // "that floats over content, and this one never does.",
        render: () => {
          const $s = $stage();
          $s.append($filler());
          const $sheet = BottomSheet.make();
          $sheet.append(
            ...$body([
              "The body starts under the button's row, not beside it.",
              "A caller whose content must reach the top edge can read " +
                "`--sheet-safe-area-inset-end` from any slotted element — it " +
                "inherits through the slot — and pad itself the same way.",
            ]),
          );
          $s.append($sheet);
          $sheet.open();
          return $s;
        },
      },
      {
        title: "Made with make(), hidden until opened",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The path the other cards do not take. `BottomSheet.make()` is " +
        // "`document.createElement`, and a custom element's constructor may not " +
        // "write attributes on its host, so the sheet hides itself when it is " +
        // "CONNECTED rather than when it is constructed. Here it is made in " +
        // "script, attached closed (nothing shows), and raised by the button. " +
        // "Close it with the scrim, the close button or Escape, and open it again.",
        render: () => {
          const $s = $stage();
          $s.append($filler());
          const $sheet = BottomSheet.make();
          $sheet.append(
            $title("made-in-script"),
            ...$body([
              "Constructed by make(), attached while closed, opened on demand.",
            ]),
          );
          $s.append($sheet);
          const $open = Button.makeWith("Open the sheet", {
            type: "primary",
            onClick: () => $sheet.open(),
          });
          $open.assignStyles({ position: "absolute", left: "16px", bottom: "16px" });
          $s.append($open);
          return $s;
        },
      },
      {
        title: "No grip",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "For a sheet that is not dismissible by gesture and does not want to " +
        // "suggest it is. The glyph is the only thing that goes — the three " +
        // "exits (scrim, close, Escape) are unconditional, because a sheet with " +
        // "no way out is a trap rather than a variant.",
        render: () =>
          $sheet("settings-avatar-upload", ["needs credentials we do not hold"], {
            noGrip: true,
          }),
      },
    ];
  }
}
