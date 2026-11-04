import { Column, Div, Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { ModalCloseButton } from "./modal-close-button";

const RELEASE_NOTES = [
  "Recurring events now keep their exceptions when you move the series.",
  "Sheets remember the last scroll position per tab, so switching back lands where you left off.",
  "Shared calendars show who changed an event and when, right in the event details.",
  "Time zone labels follow your locale; travel days show both zones side by side.",
  "Imports from CSV detect date columns automatically and preview the first rows.",
  "Keyboard: press G then T to jump to today from any view.",
  "Fixed an issue where dragging an all-day event could drop it one day early.",
];

/** A dialog-shaped surface the close button sits on. The button is
 * absolutely positioned, so the surface must be the positioned ancestor. */
function makeSurface(title: string, $body: HTMLElement): HTMLElement {
  const $surface = Div.make();
  $surface.assignStyles({
    position: "relative",
    width: "min(360px, 100%)",
    background: "var(--bg)",
    borderRadius: "16px",
    boxShadow: "var(--box-shadow-light)",
    overflow: "hidden",
  });
  const $title = Typography.h4(title);
  $title.style.padding = "20px 56px 12px 20px";
  $surface.append($title, $body);
  return $surface;
}

function makeCloseButton(): ModalCloseButton {
  const $close = ModalCloseButton.make();
  // Callers own the corner, as std-dialog does with its own #close rule.
  $close.assignStyles({ top: "12px", right: "12px", margin: "0" });
  return $close;
}

function makeReleaseNotes(scrolled: boolean): HTMLElement {
  const $body = Column.make();
  $body.assignStyles({
    gap: "10px",
    height: "160px",
    overflowY: "auto",
    padding: "0 20px 20px",
  });
  for (const note of RELEASE_NOTES) {
    // The body is a fixed-height flex column; without this the notes shrink
    // to fit it and overlap instead of scrolling.
    const $note = Typography.p(note);
    $note.style.flexShrink = "0";
    $body.appendChild($note);
  }

  const $close = makeCloseButton();
  $close.bind({ scrollSource: $body, onDismiss: () => {} });
  // The overflow check runs once at bind time, before the card has laid this
  // out; re-measure once mounted. Setting scrollTop fires the scroll event.
  requestAnimationFrame(() => {
    $close.bindScrollSource($body);
    if (scrolled) $body.scrollTop = 96;
  });

  const $surface = makeSurface("What's new in October", $body);
  $surface.appendChild($close);
  return $surface;
}

export class CoreModalCloseButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Modal Close Button";
  }

  tags(): string[] {
    return ["std-modal-close-button"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Resting",
        render: () => {
          const $body = Column.make();
          $body.assignStyles({ gap: "16px", padding: "0 20px 20px" });
          const $actions = Row.make();
          $actions.assignStyles({ gap: "8px", justifyContent: "flex-end" });
          $actions.append(
            Button.makeWith("Keep event", { type: "flat" }),
            Button.makeWith("Cancel event", { type: "destructive" }),
          );
          $body.append(
            Typography.p(
              "The event will be removed for all 6 guests. They'll get a cancellation email.",
            ),
            $actions,
          );

          const $close = makeCloseButton();
          $close.bind({ onDismiss: () => {} });
          const $surface = makeSurface("Cancel Design review?", $body);
          $surface.appendChild($close);
          return $surface;
        },
      },
      { title: "Scrollable", render: () => makeReleaseNotes(false) },
      { title: "Scrolled", render: () => makeReleaseNotes(true) },
    ];
  }
}
