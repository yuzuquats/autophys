import { Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import {
  BarChartIcon,
  CalendarIcon,
  CheckSquareIcon,
  DatabaseIcon,
  GridIcon,
  JournalIcon,
  LonaIcons,
  TimelineRowIcon,
} from "../../ui/icons";
import { SquareButton } from "./square-button";

function makeTile(label: string, icon: Option<string>): SquareButton {
  const $tile = SquareButton.make();
  if (icon != null) {
    const $icon = LonaIcons.make(icon, { sizePx: 20 });
    $icon.slot = "icon";
    $tile.appendChild($icon);
  }
  $tile.appendChild(Typography.small(label));
  return $tile;
}

function makeTileRow(...$tiles: SquareButton[]): HTMLElement {
  const $row = Row.make();
  $row.assignStyles({ gap: "8px", flexWrap: "wrap" });
  $row.append(...$tiles);
  return $row;
}

export class CoreSquareButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Square Button";
  }

  tags(): string[] {
    return ["std-square-button"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () =>
          makeTileRow(
            makeTile("New sheet", GridIcon),
            makeTile("New event", CalendarIcon),
          ),
      },
      {
        title: "Tinted",
        render: () => {
          const tiles: Array<[string, string, string]> = [
            ["Habits", CheckSquareIcon, "var(--green-dimmed)"],
            ["Journal", JournalIcon, "var(--blue-dimmed)"],
            ["Insights", BarChartIcon, "var(--purple-dimmed)"],
          ];
          return makeTileRow(
            ...tiles.map(([label, icon, background]) =>
              makeTile(label, icon).assignStyles({
                "--std-square-button-background": background,
              }),
            ),
          );
        },
      },
      {
        // The tile has no selected state of its own; the picker owns the
        // choice and repaints through the background variable.
        title: "Picker",
        render: () => {
          const layouts: Array<[string, string]> = [
            ["Grid", GridIcon],
            ["Timeline", TimelineRowIcon],
            ["Calendar", CalendarIcon],
          ];
          const $tiles: SquareButton[] = [];
          const select = (index: number) => {
            $tiles.forEach(($tile, i) => {
              $tile.assignStyles({
                "--std-square-button-background":
                  i === index ? "var(--blue-dimmed)" : null,
              });
              $tile.setAttribute("aria-pressed", String(i === index));
            });
          };
          layouts.forEach(([label, icon], index) => {
            const $tile = makeTile(label, icon);
            $tile.addPointerEvent({ onClick: () => select(index) });
            $tiles.push($tile);
          });
          select(0);
          return makeTileRow(...$tiles);
        },
      },
      {
        title: "Long label",
        render: () =>
          makeTileRow(
            makeTile("Import from Google Calendar", CalendarIcon),
            makeTile("Connect a database", DatabaseIcon),
          ),
      },
      {
        title: "No icon",
        render: () =>
          makeTileRow(makeTile("Blank sheet", null), makeTile("From template", null)),
      },
    ];
  }
}
