import { Column, Span } from "../component-builtin";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { Button } from "./button/button";
import { Disclaimer } from "./disclaimer";

function makeFrame(): HTMLElement {
  const $frame = Column.make();
  $frame.assignStyles({ gap: "8px", width: "min(360px, 100%)" });
  return $frame;
}

export class CoreDisclaimerStoryBook extends Storybook.Default {
  title(): string {
    return "Disclaimer";
  }

  tags(): string[] {
    return ["std-disclaimer"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Footnote under a form",
        render: () => {
          const $frame = makeFrame();
          const $label = Typography.small("When");
          $label.style.color = "var(--text-ter)";
          $frame.append(
            $label,
            Typography.p("Thu, Oct 15 · 2:00 – 3:00 PM"),
            Disclaimer.makeWith(
              "Times are shown in Pacific Time. Guests in other time zones see the event in their own local time.",
            ),
          );
          return $frame;
        },
      },
      {
        title: "Validation message",
        render: () => {
          // Aligned to the start, the bubble hugs a short message instead of
          // stretching across the column.
          const $frame = makeFrame();
          $frame.style.alignItems = "flex-start";
          $frame.appendChild(Disclaimer.makeWith("End time must be after start time"));
          return $frame;
        },
      },
      {
        title: "Structured content with emphasis",
        render: () => {
          // Element content lands inside the component's <p>, so phrasing
          // elements (spans, strong, a) are the right building blocks.
          const $content = Span.make();
          const $strong = document.createElement("strong");
          $strong.textContent = "Changing the starting time zone";
          $content.append(
            $strong,
            " also moves the return flight on Oct 22 to the new zone. Arrival times stay as booked.",
          );
          const $frame = makeFrame();
          $frame.appendChild(Disclaimer.makeWith($content));
          return $frame;
        },
      },
      {
        title: "Call to action in the cta slot",
        render: () => {
          const $disclaimer = Disclaimer.makeWith(
            "This calendar is read-only. Ask the owner for edit access to add or move events.",
          );
          const $cta = Button.makeWith("Request access", {
            type: "secondary",
            onClick: () => {
              $cta.textContent = "Request sent";
            },
          });
          $cta.slot = "cta";
          // The cta slot sits outside the padded text, so the caller insets
          // the button to line up with it.
          $cta.style.margin = "0 12px 12px";
          $disclaimer.appendChild($cta);

          const $frame = makeFrame();
          $frame.appendChild($disclaimer);
          return $frame;
        },
      },
      {
        title: "Reading size and inset through CSS variables",
        render: () => {
          const $frame = makeFrame();
          const $caption = Typography.small("Before you import");
          $caption.style.color = "var(--text-ter)";
          // A caption above the bubble indents by the same inset as the text.
          $caption.style.paddingInline = "16px";
          const $disclaimer = Disclaimer.makeWith(
            "Rows with a date in the first column become events. Everything else is kept as a note on the sheet, and nothing in your calendar is overwritten.",
          ).assignStyles({
            "--disclaimer-font-size": "var(--p-size)",
            "--disclaimer-inset": "16px",
          });
          $frame.append($caption, $disclaimer);
          return $frame;
        },
      },
      {
        title: "Long text scrolls within a max height",
        render: () => {
          const $frame = makeFrame();
          // The bubble inherits max-height from the host and scrolls with
          // hidden scrollbars past it.
          const $disclaimer = Disclaimer.makeWith(
            [
              "Shared calendars are visible to everyone in the workspace.",
              "Event titles, times and locations are shown to people with view access; descriptions and attachments are shown only to guests.",
              "Removing someone from the workspace removes their access on the next sync, which can take up to five minutes.",
              "Exports include every event you can see, including those on calendars shared with you.",
            ].join("\n\n"),
          ).assignStyles({ display: "block", maxHeight: "96px" });
          $frame.appendChild($disclaimer);
          return $frame;
        },
      },
    ];
  }
}
