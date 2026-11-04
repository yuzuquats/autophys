import { Storybook } from "../../ui/storybook";
import { StatLine } from "./stat-line";
import { StatPanel } from "./stat-panel";
import { UsageMeter } from "./usage-meter";

function $frame($el: HTMLElement): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.style.width = "360px";
  $wrap.appendChild($el);
  return $wrap;
}

function $meter(label: string, percent: number, detail: Option<string>): HTMLElement {
  const $m = UsageMeter.make();
  $m.bind({
    label,
    percent,
    value: `${percent.toFixed(1)}%`,
    detail,
    thresholds: UsageMeter.THRESHOLDS,
  });
  return $frame($m);
}

const HOST_ROWS: StatPanel.Row[] = [
  { kind: "meter", meter: { label: "cpu", percent: 12.4, value: "12.4%", detail: null, thresholds: UsageMeter.THRESHOLDS } },
  { kind: "meter", meter: { label: "mem", percent: 61.2, value: "61.2%", detail: "19.6/32.0G", thresholds: UsageMeter.THRESHOLDS } },
  { kind: "meter", meter: { label: "disk", percent: 82.9, value: "82.9%", detail: "158.1G free", thresholds: UsageMeter.THRESHOLDS } },
  { kind: "line", line: { label: "load", values: [{ text: "1.42 · 1.10 · 0.96", tone: "secondary" }] } },
];

function $panel(state: StatPanel.State, footer: Option<StatPanel.Footer>): HTMLElement {
  const $p = StatPanel.make();
  $p.bind({ title: "yuzuquats", meta: "macOS · up 21d 12h · 12s ago", footer });
  $p.setState(state);
  return $frame($p);
}

export class MetersStoryBook extends Storybook.Default {
  title(): string {
    return "Meters";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Usage meter — healthy / warm / hot",
        render: () => {
          const $col = document.createElement("div");
          $col.style.display = "flex";
          $col.style.flexDirection = "column";
          $col.style.gap = "14px";
          $col.append(
            $meter("cpu", 12.4, null),
            $meter("mem", 78.3, "25.1/32.0G"),
            $meter("disk", 93.7, "17.8G free"),
          );
          return $col;
        },
      },
      {
        title: "Stat line — values without a bar",
        render: () => {
          const $line = StatLine.make();
          $line.bind({
            label: "load",
            values: [{ text: "1.42 · 1.10 · 0.96", tone: "secondary" }],
          });
          return $frame($line);
        },
      },
      {
        title: "Stat panel — loaded",
        render: () => $panel({ kind: "stats", rows: HOST_ROWS }, null),
      },
      {
        title: "Stat panel — loaded, with footer strip",
        render: () =>
          $panel(
            { kind: "stats", rows: HOST_ROWS },
            { label: "processes · history", tag: "coming soon" },
          ),
      },
      {
        title: "Stat panel — pending (pulse holds the loaded height)",
        render: () => $panel({ kind: "pending" }, null),
      },
      {
        title: "Stat panel — failure",
        render: () => $panel({ kind: "failure", message: "unreachable — connect timeout" }, null),
      },
    ];
  }
}
