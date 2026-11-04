import { Storybook } from "../ui/storybook";
import { Button } from "./button/button";
import { Stepper, StepperHorizontal } from "./stepper";
import { StepperHorizontalStoryBook } from "./stepper.example";

// The core card for std-stepper-horizontal: a wizard's progress header. The
// first two examples are written for the card — the header driven through a
// wizard, and a step's body and meta, which the existing book never shows —
// and the rest is StepperHorizontalStoryBook from stepper.example.ts, reused
// as is for the marker states, the dimmed register, the dashed rail and the
// crowded titles.

const WIDTH = "min(400px, 100%)";

/** The add-host wizard's four steps. */
const STEPS = ["Machine", "Details", "Connect", "Approve"];

/** The header for a wizard standing on step `at`: done steps ticked and
 * selectable (going back is allowed), the current one ringed, the ones ahead
 * disabled until the reader gets there. */
function wizardModel(at: number): Stepper.Model {
  return {
    steps: STEPS.map((title, i) => {
      const step = Stepper.plain(title, null);
      if (i < at) {
        return {
          ...step,
          marker: "✓",
          tone: "var(--green)",
          key: String(i),
        };
      }
      if (i === at) return { ...step, current: true, key: String(i) };
      return { ...step, key: String(i), disabled: true };
    }),
  };
}

export class CoreStepperHorizontalStoryBook extends Storybook.Default {
  title(): string {
    return "Stepper Horizontal";
  }

  tags(): string[] {
    return ["std-stepper-horizontal"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Add-host wizard on step 3 — Next, Back, or click a done step",
        render: () => {
          let at = 2;
          const $said = Storybook.Card.StatusLine.make();

          const $stepper = StepperHorizontal.make();
          $stepper.style.width = WIDTH;
          // Only keyed, enabled steps answer; the ones ahead are disabled, so
          // the reader can go back by clicking but not skip forward.
          $stepper.onSelect = (key) => go(Number(key));

          const $back = Button.makeWith("Back", {
            type: "flat",
            onClick: () => go(at - 1),
          });
          const $next = Button.makeWith("Next", {
            type: "primary",
            onClick: () => go(at + 1),
          });
          const go = (step: number) => {
            at = Math.max(0, Math.min(STEPS.length - 1, step));
            $stepper.bind(wizardModel(at));
            $said.bindText(`Step ${at + 1} of ${STEPS.length}: ${STEPS[at]}`);
          };
          go(at);

          const $controls = Storybook.Card.Controls.make();
          $controls.append($back, $next);
          return { $content: $stepper, $controls, $status: $said };
        },
      },
      {
        title: "Bodies and meta under the titles",
        render: () => {
          // Rarely what a header wants, but drawn when given: the meta sits
          // under the title and the body under that, both centred.
          const $stepper = StepperHorizontal.makeWith({
            steps: [
              {
                ...Stepper.plain("Machine", "rwc-03"),
                marker: "✓",
                tone: "var(--green)",
              },
              {
                ...Stepper.plain("Details", "tento-agent"),
                marker: "✓",
                tone: "var(--green)",
              },
              {
                ...Stepper.plain("Connect", "Waiting for the host"),
                meta: "0:42",
                current: true,
              },
              Stepper.plain("Approve", null),
            ],
          });
          $stepper.style.width = WIDTH;
          return $stepper;
        },
      },
      ...new StepperHorizontalStoryBook().examples(),
    ];
  }
}
