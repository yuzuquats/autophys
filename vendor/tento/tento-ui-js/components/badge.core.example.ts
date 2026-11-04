import { Column, Div, Row } from "../component-builtin";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import {
  CalendarIcon,
  CheckSquareIcon,
  CheckmarkIcon,
  GearIcon,
  LonaIcons,
} from "../ui/icons";
import { Badge } from "./badge";
import { Button } from "./button/button";
import { IconButton } from "./icon-button";

/** A badge positions itself against its nearest positioned ancestor, so every
 * anchor here is a relative box around the thing being badged. */
function makeAnchor($child: HTMLElement): HTMLElement {
  const $anchor = Div.make();
  $anchor.assignStyles({ position: "relative", display: "inline-flex" });
  $anchor.appendChild($child);
  return $anchor;
}

function makeToolbarButton(icon: string, label: string): IconButton {
  return IconButton.makeWith({
    content: LonaIcons.$svg(icon),
    sizePx: 32,
    squarish: true,
    ariaLabel: label,
    backgroundColor: "var(--bg-surface-light)",
  });
}

function makeTile(): HTMLElement {
  const $tile = Div.make();
  $tile.assignStyles({
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    background: "var(--bg-surface-light)",
  });
  return $tile;
}

function makeLabeled($anchor: HTMLElement, label: string): HTMLElement {
  const $cell = Column.make();
  $cell.assignStyles({ gap: "8px", alignItems: "center" });
  const $label = Typography.small(label);
  $label.style.color = "var(--text-ter)";
  $cell.append($anchor, $label);
  return $cell;
}

function makeGallery(): HTMLElement {
  const $row = Row.make();
  $row.assignStyles({
    gap: "20px",
    flexWrap: "wrap",
    alignItems: "flex-end",
    padding: "8px",
  });
  return $row;
}

export class CoreBadgeStoryBook extends Storybook.Default {
  title(): string {
    return "Badge";
  }

  tags(): string[] {
    return ["std-badge"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Unread counts on toolbar icons",
        render: () => {
          const $row = makeGallery();

          const $calendar = makeAnchor(makeToolbarButton(CalendarIcon, "Invitations"));
          $calendar.appendChild(Badge.makeWith({ content: 3, variant: "error" }));

          const $tasks = makeAnchor(makeToolbarButton(CheckSquareIcon, "Tasks"));
          $tasks.appendChild(Badge.makeWith({ content: 12, variant: "info" }));

          const $settings = makeAnchor(makeToolbarButton(GearIcon, "Settings"));
          $settings.appendChild(Badge.makeWith({ variant: "dot" }));

          $row.append($calendar, $tasks, $settings);
          return $row;
        },
      },
      {
        title: "Every variant",
        render: () => {
          const $row = makeGallery();
          const variants: Array<NonNullable<Badge.Props["variant"]>> = [
            "error",
            "warning",
            "success",
            "info",
            "purple",
            "default",
            "dot",
          ];
          for (const variant of variants) {
            const $anchor = makeAnchor(makeTile());
            $anchor.appendChild(Badge.makeWith({ content: 4, variant }));
            $row.appendChild(makeLabeled($anchor, variant));
          }
          return $row;
        },
      },
      {
        title: "Wider counts grow away from the corner",
        // The badge pins its left cap to the corner, so longer text extends
        // outward instead of covering more of the anchor.
        render: () => {
          const $row = makeGallery();
          for (const count of [1, 9, 42, "99+"]) {
            const $anchor = makeAnchor(makeTile());
            $anchor.appendChild(Badge.makeWith({ content: count, variant: "error" }));
            $row.appendChild($anchor);
          }
          return $row;
        },
      },
      {
        title: "Corner positions",
        render: () => {
          const $row = makeGallery();
          const positions: Array<NonNullable<Badge.Props["position"]>> = [
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right",
          ];
          for (const position of positions) {
            const $anchor = makeAnchor(makeTile());
            $anchor.appendChild(Badge.makeWith({ content: 2, variant: "info", position }));
            $row.appendChild(makeLabeled($anchor, position));
          }
          return $row;
        },
      },
      {
        title: "Element content: a checkmark on success",
        render: () => {
          const $row = makeGallery();
          const $anchor = makeAnchor(makeToolbarButton(CalendarIcon, "Calendar synced"));
          $anchor.appendChild(
            Badge.makeWith({
              content: LonaIcons.make(CheckmarkIcon, {
                sizePx: 8,
                color: "var(--text-sec-on-solid)",
              }),
              variant: "success",
            }),
          );
          $row.appendChild(makeLabeled($anchor, "Synced"));
          return $row;
        },
      },
      {
        title: "Live count with bindContent",
        render: () => {
          const $frame = Column.make();
          $frame.assignStyles({ gap: "12px", alignItems: "flex-start" });

          const $anchor = makeAnchor(makeToolbarButton(CalendarIcon, "Invitations"));
          const $badge = Badge.makeWith({ content: 2, variant: "error" });
          $anchor.appendChild($badge);

          let unread = 2;
          const render = () => {
            $badge.bindContent(unread);
            // Absent content still draws an empty pill, so the caller hides
            // the badge outright when there is nothing to count.
            $badge.hidden = unread === 0;
          };

          const $controls = Row.make();
          $controls.assignStyles({ gap: "8px" });
          $controls.append(
            Button.makeWith("New invitation", {
              type: "secondary",
              onClick: () => {
                unread++;
                render();
              },
            }),
            Button.makeWith("Mark all read", {
              type: "flat",
              onClick: () => {
                unread = 0;
                render();
              },
            }),
          );

          $frame.append($anchor, $controls);
          return $frame;
        },
      },
    ];
  }
}
