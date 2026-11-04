import { Div, Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { ResizeHandle } from "./resize-handle";

/** The handle only means something between two things it resizes, so the
 * example is a pane pair; the handle is the component under review. */
function $panes(): HTMLElement {
  const $row = Row.make();
  $row.style.height = "120px";
  $row.style.width = "100%";
  const $left = Div.make();
  $left.style.width = "160px";
  $left.style.flex = "none";
  $left.style.background = "var(--bg-surface-light)";
  const $right = Div.make();
  $right.style.flex = "1";
  $right.style.background = "var(--bg-surface-light)";
  const $handle = ResizeHandle.makeWith({
    orientation: "vertical",
    ariaLabel: "Resize the left pane",
    value: 160,
    min: 80,
    max: 400,
    onResize: (px) => { $left.style.width = `${px}px`; },
    onResizeEnd: null,
    stepPx: null,
  });
  $row.append($left, $handle, $right);
  return $row;
}

export class ResizeHandleStoryBook extends Storybook.Default {
  title(): string {
    return "Resize Handle";
  }

  tags(): string[] {
    return ["std-resize-handle"];
  }

  examples(): Storybook.Example[] {
    return [{ title: "Between two panes (drag, or focus and press the arrows)", render: () => $panes() }];
  }
}
