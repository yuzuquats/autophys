import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { Chip } from "./chip";
import { ChipRow } from "./chip-row";

// `chip.example.ts` is the chip's card: one tone per chip, what each fill
// means. This is the ROW's card — the strip that holds them. What a row owns
// is small and all of it is behaviour: it wraps instead of scrolling, a bind
// replaces every chip it held, and an empty bind hides the whole strip so a
// consumer never has to ask whether it is worth rendering.

// One build on the fleet, as the stack log strip draws it: facts about the
// build first (neutral), then where each step stands (tinted).
const BUILD: Chip.ViewModel[] = [
  { label: "rwc-01", tone: "neutral" },
  { label: "aarch64-apple-darwin", tone: "neutral" },
  { label: "compile", tone: "done" },
  { label: "tests 212/214", tone: "running" },
  { label: "lint", tone: "attention" },
  { label: "notarize", tone: "pending" },
];

const TAGS = [
  "scheduling",
  "productivity",
  "trial-offer",
  "screenshot-creative",
  "sunday-anxiety",
  "time-blocking",
  "anti-planner",
  "timezones",
  "subcolumns",
];

// A narrow column with a caption above, so a story reads like the surface a
// row actually sits in: a label, then its strip.
function $column(caption: string, $row: ChipRow, width: string): HTMLElement {
  const $frame = Column.make();
  $frame.assignStyles({ width, gap: "6px" });
  const $caption = Typography.small(caption);
  $caption.style.color = "var(--text-ter)";
  $frame.append($caption, $row);
  return $frame;
}

function $controls(): HTMLElement {
  return Storybook.Card.Controls.make();
}

export class CoreChipRowStoryBook extends Storybook.Default {
  title(): string {
    return "Chip Row";
  }

  tags(): string[] {
    return ["std-chip-row"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Facts and states in one strip",
        render: () =>
          $column("release 0.1.55 · nightly", ChipRow.makeWith(BUILD), "min(340px, 100%)"),
      },
      {
        // The frame is resizable: drag its corner. The strip only ever wraps
        // onto another line; it never scrolls and never clips a chip.
        title: "Wraps against its width — drag the corner",
        render: () => {
          const $row = ChipRow.makeWith(
            TAGS.map((label) => ({ label, tone: "neutral" as Chip.Tone })),
          );
          const $frame = $column("campaign tags", $row, "260px");
          $frame.assignStyles({
            resize: "horizontal",
            overflow: "hidden",
            minWidth: "120px",
            maxWidth: "100%",
            padding: "8px",
            border: "1px dashed var(--divider)",
            borderRadius: "8px",
          });
          return $frame;
        },
      },
      {
        // `bind` is a replace, not a merge: every step below rebinds the
        // whole list, which is how a consumer drives a strip from its model.
        title: "Rebinding as a pipeline advances",
        render: () => {
          const STEPS = ["fetch", "decompose", "analysis", "publish"];
          let cursor = 0;
          let failed = false;

          const chipsAt = (): Chip.ViewModel[] =>
            STEPS.map((label, index) => {
              if (index < cursor) return { label, tone: "done" as Chip.Tone };
              if (index === cursor && failed) return { label, tone: "failed" as Chip.Tone };
              if (index === cursor) return { label, tone: "running" as Chip.Tone };
              return { label, tone: "pending" as Chip.Tone };
            });

          const $row = ChipRow.makeWith(chipsAt());
          const $status = Storybook.Card.StatusLine.make();
          const rebind = () => {
            $row.bind(chipsAt());
            $status.bindText(
              cursor >= STEPS.length
                ? "All steps done"
                : `${failed ? "Failed at" : "Running"} ${STEPS[cursor]}`,
            );
          };
          rebind();

          const $buttons = $controls();
          $buttons.append(
            Button.makeWith("Advance", {
              type: "primary",
              onClick: () => {
                if (failed || cursor >= STEPS.length) return;
                cursor++;
                rebind();
              },
            }),
            Button.makeWith("Fail step", {
              type: "secondary",
              onClick: () => {
                if (cursor >= STEPS.length) return;
                failed = true;
                rebind();
              },
            }),
            Button.makeWith("Restart", {
              type: "flat",
              onClick: () => {
                cursor = 0;
                failed = false;
                rebind();
              },
            }),
          );

          return {
            $content: $column("ad 4812 · processing", $row, "min(340px, 100%)"),
            $controls: $buttons,
            $status,
          };
        },
      },
      {
        // The row sits between a heading and a paragraph. Bound empty, it is
        // `hidden`, so the paragraph closes up under the heading with no
        // stray band of strip-height where the chips were.
        title: "An empty bind hides the row",
        render: () => {
          const LABELS: Chip.ViewModel[] = [
            { label: "webp", tone: "neutral" },
            { label: "decompose v3", tone: "done" },
          ];
          let populated = false;

          const $frame = Column.make();
          $frame.assignStyles({ width: "min(340px, 100%)", gap: "6px" });
          const $row = ChipRow.makeWith([]);
          const $body = Typography.p(
            "Sunday planning screenshot, 1080×1920. Uploaded from the campaign drop.",
          );
          $body.style.color = "var(--text-sec)";
          $frame.append(Typography.h6("hero-sunday.webp"), $row, $body);

          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Bound to [] — the row is hidden");
          const $buttons = $controls();
          $buttons.append(
            Button.makeWith("Toggle chips", {
              type: "secondary",
              onClick: () => {
                populated = !populated;
                $row.bind(populated ? LABELS : []);
                $status.bindText(
                  populated
                    ? `Bound to ${LABELS.length} chips`
                    : "Bound to [] — the row is hidden",
                );
              },
            }),
          );
          return { $content: $frame, $controls: $buttons, $status };
        },
      },
      {
        // The one layout knob the row exposes. Everything else about a chip
        // is the chip's own business.
        title: "Spacing through --chip-row-gap",
        render: () => {
          const $frame = Column.make();
          $frame.assignStyles({ width: "min(340px, 100%)", gap: "16px" });
          for (const gap of ["4px", "8px"]) {
            const $row = ChipRow.makeWith(BUILD.slice(0, 4));
            $row.style.setProperty("--chip-row-gap", gap);
            $frame.append($column(`--chip-row-gap: ${gap}`, $row, "100%"));
          }
          return $frame;
        },
      },
    ];
  }
}
