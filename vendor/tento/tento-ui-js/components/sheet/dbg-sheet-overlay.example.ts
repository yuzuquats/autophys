/// <reference lib="dom" />

import { Column } from "@tento-ui/component-builtin";
import { Storybook } from "@tento-ui/ui/storybook";
import { SheetDebugOverlay } from "./dbg-sheet-overlay";

function renderOverlay(
  widthPx: number,
  heightPx: number,
  label: string,
  color: string,
): HTMLElement {
  const $root = Column.make();
  $root.style.width = `${Math.max(widthPx + 24, 120)}px`;
  $root.style.height = `${Math.max(heightPx + 24, 80)}px`;
  $root.style.padding = "12px";
  $root.style.background = "var(--bg-surface-light)";
  $root.style.borderRadius = "12px";

  const $overlay = SheetDebugOverlay.make().bind({
    label,
    color,
    widthPx,
    heightPx,
  });
  $root.appendChild($overlay);

  return $root;
}

export class SheetDebugOverlayStoryBook extends Storybook.Default {
  override title(): string {
    return "Sheet Debug Overlay";
  }

  override examples(): Storybook.Example[] {
    return [
      {
        title: "Default cell",
        render: () => renderOverlay(140, 44, "r3 c10", "var(--blue)"),
      },
      {
        title: "Stacked cell",
        render: () => renderOverlay(140, 26, "r2 c4 s1", "var(--teal)"),
      },
      {
        title: "Span owner",
        render: () => renderOverlay(280, 44, "r5 span 7-13", "var(--orange)"),
      },
      {
        title: "Static span",
        render: () =>
          renderOverlay(340, 44, "r9 static yw-2026-8", "var(--yellow)"),
      },
    ];
  }
}
