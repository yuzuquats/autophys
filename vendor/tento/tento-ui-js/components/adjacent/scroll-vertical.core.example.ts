import { Row } from "@tento-ui/component-builtin";
import { Button } from "@tento-ui/components/button/button";
import { Chip } from "@tento-ui/components/chip/chip";
import { Storybook } from "@tento-ui/ui/storybook";
import { Typography } from "@tento-ui/ui/typography";
import { ScrollVertical } from "@tento-scroll/vertical/scroll-vertical";
import { ScrollVerticalStoryBook } from "@tento-scroll/vertical/scroll-vertical.example";

// `std-scroll-vertical` lives in tento-scroll-js, which the core catalog
// scanner does not walk. It is a virtualised list host: the caller says how
// to create, bind and recycle a row, and the host keeps only the rows on
// screen (plus a small buffer) in the DOM, repositioning pooled elements as
// the list scrolls. A list of ten thousand costs what a list of twelve does.
//
// The first three examples are written for this card; the last two are the
// package's own storybook, forwarded.

const ROW_PX = 36;
// Each level travels with a message that earns it.
const LINES: { level: Chip.ViewModel; text: string }[] = [
  { level: { label: "info", tone: "neutral" }, text: "registry refresh: 14 services" },
  { level: { label: "ok", tone: "done" }, text: "fleet heartbeat from rwc-03" },
  { level: { label: "info", tone: "neutral" }, text: "spool drained: 3 artifacts" },
  { level: { label: "sync", tone: "running" }, text: "release-ci picked up 0.1.55-rc.3" },
  { level: { label: "info", tone: "neutral" }, text: "tento.localhost route updated" },
  { level: { label: "warn", tone: "attention" }, text: "notary queue slow: 41s" },
  { level: { label: "ok", tone: "done" }, text: "commit-review published" },
  { level: { label: "error", tone: "failed" }, text: "ssh rwc-05: connection reset" },
];

// A log line is a pure function of its index, so the list needs no backing
// array at all — the host asks for row N and the row is computed.
function lineAt(index: number, seed: number): { time: string; level: Chip.ViewModel; text: string } {
  // One line every nine seconds from 08:00:00, so the clock column reads in
  // order as you scroll.
  const seconds = (8 * 3600 + index * 9) % 86_400;
  const pad = (n: number) => String(n).padStart(2, "0");
  const line = LINES[(index * 5 + seed) % LINES.length];
  return {
    time: `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`,
    level: line.level,
    text: `#${index + 1} ${line.text}`,
  };
}

// One pooled row element. Its children are created once and only their text
// and tone change on bind, which is the whole point of pooling.
function $makeRow(): HTMLElement {
  const $row = Row.make();
  $row.assignStyles({
    alignItems: "center",
    gap: "10px",
    padding: "0 12px",
    boxSizing: "border-box",
    borderBottom: "1px solid var(--divider)",
  });
  const $time = Typography.small("");
  $time.dataset.part = "time";
  $time.style.color = "var(--text-ter)";
  $time.style.fontVariantNumeric = "tabular-nums";
  const $chip = Chip.make();
  $chip.dataset.part = "level";
  const $text = Typography.small("");
  $text.dataset.part = "text";
  $text.assignStyles({
    color: "var(--text-sec)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: "0",
  });
  $row.append($time, $chip, $text);
  return $row;
}

function bindRow($row: HTMLElement, index: number, seed: number): void {
  const line = lineAt(index, seed);
  $row.querySelector<HTMLElement>("[data-part=time]")!.textContent = line.time;
  ($row.querySelector("[data-part=level]") as Chip).bind(line.level);
  $row.querySelector<HTMLElement>("[data-part=text]")!.textContent = line.text;
}

// The host in a fixed-height frame. The frame's height is load-bearing: a
// virtualised list sizes its window from its own box, so it needs one.
function $logList(
  count: number,
  seed: () => number,
): ScrollVertical<HTMLElement> {
  const $list = ScrollVertical.make() as ScrollVertical<HTMLElement>;
  $list.initialize({
    onCreate: () => $makeRow(),
    onBind: ($row, index) => bindRow($row, index, seed()),
  });
  void $list.bind({ cellHeightPx: ROW_PX, maxIndex: count - 1 });
  $list.assignStyles({
    display: "block",
    height: "320px",
    borderRadius: "10px",
    background: "var(--bg)",
    boxShadow: "var(--box-shadow)",
  });
  return Storybook.fill($list, "360px");
}

function $buttons(): HTMLElement {
  return Storybook.Card.Controls.make();
}

export class CoreScrollVerticalStoryBook extends Storybook.Default {
  title(): string {
    return "Scroll Vertical";
  }

  tags(): string[] {
    return ["std-scroll-vertical"];
  }

  examples(): Storybook.Example[] {
    const [tiles, anchor] = new ScrollVerticalStoryBook().examples();
    return [
      {
        title: "Ten thousand log lines at a fixed pitch",
        render: () => $logList(10_000, () => 0),
      },
      {
        // Same row count, different content. The geometry is unchanged, so a
        // plain bind would keep every rendered row's old text;
        // `contextDirtied` is what tells the host the data behind the indices
        // moved and every visible row must rebind.
        title: "Swapping the dataset in place",
        render: () => {
          let seed = 0;
          const $list = $logList(500, () => seed);
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Dataset A");

          const $controls = $buttons();
          $controls.append(
            Button.makeWith("Swap dataset", {
              type: "primary",
              onClick: () => {
                seed = seed === 0 ? 3 : 0;
                void $list.bind({
                  cellHeightPx: ROW_PX,
                  maxIndex: 499,
                  initialIndex: $list.scrollEngine.viewport.visible.indexRange.start ?? 0,
                  contextDirtied: true,
                });
                $status.bindText(seed === 0 ? "Dataset A" : "Dataset B");
              },
            }),
          );
          return { $content: $list, $controls, $status };
        },
      },
      { ...tiles, title: "Pooled tiles at a 120px pitch" },
      { ...anchor, title: "Rows growing above the reader stay anchored" },
    ];
  }
}
