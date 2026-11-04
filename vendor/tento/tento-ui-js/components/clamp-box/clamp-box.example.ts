import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";

import { ClampBox } from "./clamp-box";

// The clamp only means anything at a real measure — a column, not a full page.
const COLUMN_WIDTH_PX = 340;

function $column($child: HTMLElement): HTMLElement {
  const $root = Column.make();
  $root.assignStyles({
    width: `${COLUMN_WIDTH_PX}px`,
    maxWidth: "100%",
    padding: "16px",
  });
  $root.appendChild($child);
  return $root;
}

const PARAGRAPHS = [
  "Every Sunday night you drag the same twelve blocks across the same seven " +
    "columns, and by Tuesday the whole board is a lie.",
  "One moved standup and the rest of the week is wrong: the focus block lands " +
    "on lunch, the gym slot slides into a call, and the plan stops matching the day.",
  "Lona keeps the shape of the week instead of the times. Move one block and " +
    "the rest settle around it, in your time zone and everyone else's.",
  "Recurring work stays recurring. Exceptions stay exceptions, even when the " +
    "series moves.",
  "Shared calendars show who changed an event and when, right in the event " +
    "details, so nobody has to ask.",
  "Imports from CSV detect date columns automatically and preview the first " +
    "rows before anything is written.",
  "When the week finally holds, Lona remembers why: every change is a row you " +
    "can read back.",
  "Try it on next week first. Nothing on this week's board moves until you say so.",
];

// A block of prose tall enough to overflow any sane cap.
function $prose(paragraphs: number): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.style.display = "grid";
  $wrap.style.gap = "12px";
  for (let i = 0; i < paragraphs; i++) {
    const $p = document.createElement("p");
    $p.style.margin = "0";
    $p.style.lineHeight = "1.5";
    $p.textContent = PARAGRAPHS[i % PARAGRAPHS.length];
    $wrap.appendChild($p);
  }
  return $wrap;
}

// A solid panel, so the fade has a ground that is NOT the page background —
// the case `--clamp-box-fade-color` exists for.
function $panel(heightPx: number, label: string): HTMLElement {
  const $el = document.createElement("div");
  $el.style.height = `${heightPx}px`;
  $el.style.background = "white";
  $el.style.color = "#4a4d8c";
  $el.style.fontFamily = "monospace";
  $el.style.padding = "16px";
  $el.style.boxSizing = "border-box";
  $el.textContent = label;
  return $el;
}

function $clamped(
  $content: HTMLElement,
  vm: Partial<ClampBox.ViewModel>,
): ClampBox {
  const $box = ClampBox.makeWith({
    maxHeightPx: vm.maxHeightPx ?? 220,
    expandLabel: vm.expandLabel ?? null,
    collapseLabel: vm.collapseLabel ?? null,
    onToggle: vm.onToggle ?? null,
  });
  $box.appendChild($content);
  return $box;
}

export class ClampBoxStoryBook extends Storybook.Default {
  title(): string {
    return "Clamp Box";
  }

  tags(): string[] {
    return ["std-clamp-box"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Overflowing",
        render: () => $column($clamped($prose(8), { maxHeightPx: 220 })),
      },
      {
        title: "Fits",
        render: () => $column($clamped($prose(1), { maxHeightPx: 220 })),
      },
      {
        title: "Solid fade",
        render: () => {
          const $box = $clamped($panel(900, "screenshot.png"), {
            maxHeightPx: 260,
          });
          $box.style.setProperty("--clamp-box-fade-color", "white");
          return $column($box);
        },
      },
      {
        title: "Late content",
        render: () => {
          const $content = $prose(1);
          const $box = $clamped($content, { maxHeightPx: 200 });
          setTimeout(() => $content.appendChild($panel(600, "late.png")), 1000);
          return $column($box);
        },
      },
      {
        title: "Custom labels",
        render: () =>
          $column(
            $clamped($prose(8), {
              maxHeightPx: 200,
              expandLabel: "Read more",
              collapseLabel: "Read less",
            }),
          ),
      },
    ];
  }
}
