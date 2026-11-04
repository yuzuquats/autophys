import "../squircle/squircle";

import { Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { StatusMark } from "./status-mark";

const STATES: StatusMark.State[] = ["progress", "done", "error"];

function $strip(
  variant: StatusMark.Variant,
  boxPx: number,
  glyphPx: number,
): HTMLElement {
  const $row = Row.make();
  $row.style.alignItems = "center";
  $row.style.gap = "10px";
  for (const state of STATES) {
    const $cell = Row.make();
    $cell.style.alignItems = "center";
    const $mark = StatusMark.makeWith({ state, variant, label: state });
    $mark.style.setProperty("--status-mark-box", `${boxPx}px`);
    $mark.style.setProperty("--status-mark-glyph", `${glyphPx}px`);
    $cell.append($mark, Typography.small(state));
    $row.append($cell);
  }
  return $row;
}

export class StatusMarkStoryBook extends Storybook.Default {
  title(): string {
    return "Status Mark";
  }

  tags(): string[] {
    return ["std-status-mark"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Solid — the thing itself is in this state",
        render: () => $strip("solid", 20, 8),
      },
      {
        title: "Outline — a container, summarising what it holds",
        render: () => $strip("outline", 20, 8),
      },
      {
        title: "Rail metrics (12px box, 8px glyph) — dense list rows",
        render: () => $strip("solid", 12, 8),
      },
      {
        title:
          "Header metrics (20px box, 8px glyph) — the same glyph, more air",
        render: () => $strip("solid", 20, 8),
      },
      {
        title: "Container and leaf side by side, one tone",
        render: () => {
          const $row = Row.make();
          $row.style.alignItems = "center";
          $row.style.gap = "14px";
          for (const variant of ["outline", "solid"] as StatusMark.Variant[]) {
            const $cell = Row.make();
            $cell.style.alignItems = "center";
            $cell.append(
              StatusMark.makeWith({
                state: "progress",
                variant,
                label: `running (${variant})`,
              }),
              Typography.small(variant === "outline" ? "task" : "session"),
            );
            $row.append($cell);
          }
          return $row;
        },
      },
    ];
  }
}
