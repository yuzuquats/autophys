import { Storybook } from "@tento-ui/ui/storybook";
import { ContextMeter } from "./context-meter";

/** The thresholds are the reviewable part: a bar that never changes colour
 * makes the reader do the arithmetic, and one that changes too early has
 * cried wolf before the number mattered. */
export class ContextMeterStoryBook extends Storybook.Default {
  title(): string {
    return "Context meter";
  }

  tags(): string[] {
    return ["std-context-meter"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "The three levels — quiet under 75%, warn, then the limit",
        render: () => {
          const $wrap = column();
          $wrap.append(
            ContextMeter.makeWith({ used: 23_188, limit: 1_000_000 }),
            ContextMeter.makeWith({ used: 712_400, limit: 1_000_000 }),
            ContextMeter.makeWith({ used: 780_000, limit: 1_000_000 }),
            ContextMeter.makeWith({ used: 961_500, limit: 1_000_000 }),
          );
          return $wrap;
        },
      },
      {
        title: "The label never changes width as the number climbs",
        render: () => {
          const $wrap = column();
          $wrap.append(
            ContextMeter.makeWith({ used: 512, limit: 1_000_000 }),
            ContextMeter.makeWith({ used: 9_400, limit: 1_000_000 }),
            ContextMeter.makeWith({ used: 128_000, limit: 1_000_000 }),
            ContextMeter.makeWith({ used: 1_240_000, limit: 2_000_000 }),
          );
          return $wrap;
        },
      },
      {
        title: "Bar only — for a composer with no room for words",
        render: () =>
          ContextMeter.makeWith({
            used: 640_000,
            limit: 1_000_000,
            showLabel: false,
          }),
      },
      {
        title: "The caller's own words",
        render: () =>
          ContextMeter.makeWith({
            used: 812_000,
            limit: 1_000_000,
            text: "81% of context used",
          }),
      },
      {
        title: "A zero limit degrades to an empty bar, not a divide by zero",
        render: () => ContextMeter.makeWith({ used: 512, limit: 0 }),
      },
      {
        title: "Over the limit clamps rather than overflowing its track",
        render: () =>
          ContextMeter.makeWith({ used: 1_400_000, limit: 1_000_000 }),
      },
    ];
  }
}

function column(): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.style.display = "flex";
  $wrap.style.flexDirection = "column";
  $wrap.style.alignItems = "flex-start";
  $wrap.style.gap = "8px";
  return $wrap;
}
