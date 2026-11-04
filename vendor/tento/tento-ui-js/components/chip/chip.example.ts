import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";

import { Chip } from "./chip";
import { ChipRow } from "./chip-row";

const FACTS: Chip.Tone[] = ["neutral", "muted"];
const STATES: Chip.Tone[] = ["done", "running", "pending", "attention", "failed"];

export class ChipStoryBook extends Storybook.Default {
  title(): string {
    return "Chip (std-chip / std-chip-row)";
  }

  tags(): string[] {
    return ["std-chip"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Fact tones — a value, so the neutral fill and no mark",
        render: () =>
          ChipRow.makeWith(FACTS.map((tone) => ({ label: tone, tone }))),
      },
      {
        title: "State tones — where it stands, so the fill carries the hue",
        render: () =>
          ChipRow.makeWith(STATES.map((tone) => ({ label: tone, tone }))),
      },
      {
        title: "A pipeline that has run",
        render: () =>
          ChipRow.makeWith([
            { label: "webp", tone: "neutral" },
            { label: "decompose v3", tone: "done" },
            { label: "analysis v3", tone: "done" },
          ]),
      },
      {
        title: "A pipeline that needs attention",
        render: () =>
          ChipRow.makeWith([
            { label: "webp", tone: "neutral" },
            { label: "decompose v2 stale", tone: "attention" },
            { label: "analysis v2", tone: "done" },
          ]),
      },
      {
        title: "A pipeline that has not started",
        render: () => ChipRow.makeWith([{ label: "no decompose", tone: "pending" }]),
      },
      {
        title: "Wrapping past the measure",
        // The frame is load-bearing here and only here: the strip wraps
        // against a bounded width, which is the behaviour on show.
        render: () => {
          const $frame = Column.make();
          $frame.assignStyles({ width: "min(320px, 100%)" });
          $frame.appendChild(
            ChipRow.makeWith(
              [
                "scheduling",
                "productivity",
                "trial-offer",
                "screenshot-creative",
                "sunday-anxiety",
                "time-blocking",
                "anti-planner",
              ].map((label) => ({ label, tone: "neutral" as Chip.Tone })),
            ),
          );
          return $frame;
        },
      },
      {
        title: "Empty row hides itself",
        render: () => {
          const $frame = Column.make();
          $frame.assignStyles({ width: "min(320px, 100%)" });
          $frame.appendChild(ChipRow.makeWith([]));
          const $rule = document.createElement("div");
          $rule.style.borderTop = "1px solid var(--divider)";
          $rule.style.paddingTop = "8px";
          $frame.appendChild($rule);
          return $frame;
        },
      },
    ];
  }
}
