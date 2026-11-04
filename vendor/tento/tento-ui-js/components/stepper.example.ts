import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { Stepper, StepperHorizontal } from "./stepper";

// Every card is the component itself, at a width, with nothing around it.
//
// The marker-size pair does the real work here: it asks whether the geometry is
// genuinely derived, by rendering the same steps at the sizes the hand-rolled
// copies had each picked (16px in the add-host modal, 20px in the accordion,
// 28px on the pricing page), where moving --step-marker-size alone has to be
// enough for the rail to still meet the circles.
//
// The row register has its own book at the bottom of this file, against
// std-stepper-horizontal. Read the two side by side: they share a step model
// and a mark, and everything else about them is different on purpose.

const WIDTH = "420px";

function $stepper(model: Stepper.Model, vars: Record<string, string>): Stepper {
  const $s = Stepper.makeWith(model);
  $s.style.width = WIDTH;
  for (const [k, v] of Object.entries(vars)) $s.style.setProperty(k, v);
  return $s;
}

function step(title: string, body: Option<string>): Stepper.Step {
  return Stepper.plain(title, body);
}

const SETUP: Stepper.Model = {
  steps: [
    step("Create the user", "In the admin group, with a password you keep."),
    step("Turn on Remote Login", "Limited to that user — not to everyone."),
    step("Run the command", "It announces the machine to the fleet."),
  ],
};

const TITLES_ONLY: Stepper.Model = {
  steps: [
    step("Create the user", null),
    step("Turn on Remote Login", null),
    step("Run the command", null),
  ],
};

/** A title carrying its own inline markup — the add-host modal's real shape,
 * where the user name and the setting are bold inside the sentence. Built as a
 * typography component at the call site, because it lands in the stepper's
 * shadow root where the caller's stylesheet cannot follow it. */
function $richTitle(lead: string, bold: string, tail: string): HTMLElement {
  const $t = Typography.p(lead);
  const $b = document.createElement("b");
  $b.textContent = bold;
  $t.append($b, document.createTextNode(tail));
  return $t;
}

const RICH: Stepper.Model = {
  steps: [
    Stepper.plain($richTitle("Create user ", "tento-agent", ", in the admin group"), null),
    Stepper.plain($richTitle("System Settings → Sharing → ", "Remote Login", " on"), null),
  ],
};

const TONED: Stepper.Model = {
  steps: [
    { ...Stepper.plain("Plan committed", null), marker: "✓", tone: "var(--green)" },
    { ...Stepper.plain("Component built", null), marker: "✓", tone: "var(--green)" },
    Stepper.plain("Adoption", "Two sites left."),
  ],
};

const WRAPPING: Stepper.Model = {
  steps: [
    step(
      "A title long enough to wrap onto a second line, which is where the marker's vertical alignment stops being a matter of opinion",
      null,
    ),
    step("A short one after it", null),
  ],
};

export class StepperStoryBook extends Storybook.Default {
  title(): string {
    return "Stepper (std-stepper)";
  }

  tags(): string[] {
    return ["std-stepper"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Titles and bodies",
        render: () => $stepper(SETUP, {}),
      },
      {
        title: "Titles only",
        render: () => $stepper(TITLES_ONLY, {}),
      },
      {
        title: "A title with its own inline markup",
        render: () => $stepper(RICH, {}),
      },
      {
        title: "Overridden markers, toned",
        render: () => $stepper(TONED, {}),
      },
      {
        title: "A wrapping title",
        render: () => $stepper(WRAPPING, {}),
      },
      {
        title: "16px marker — the add-host modal's size",
        render: () =>
          $stepper(TITLES_ONLY, {
            "--step-marker-size": "16px",
            "--step-marker-font-size": "var(--text-7px)",
          }),
      },
      {
        title: "28px marker, filled — the pricing page's size",
        render: () =>
          $stepper(SETUP, {
            "--step-marker-size": "28px",
            "--step-marker-font-size": "var(--text-12px)",
            "--step-marker-border": "none",
            "--step-marker-bg":
              "color-mix(in srgb, var(--bg) 86%, var(--text-pri) 14%)",
            "--step-marker-color": "var(--text-pri)",
            "--step-gap": "16px",
            "--step-spacing": "24px",
            "--step-title-size": "var(--text-12px)",
          }),
      },
    ];
  }
}

/* ---------------------------------------------------------------------------
   The row: std-stepper-horizontal.
   --------------------------------------------------------------------------- */

// Same step model, same marks. What these cards have to show is that the row is
// its own component rather than the column with a flag: the cells are equal
// width, the mark sits above its title, and the state vocabulary — done,
// current, pending — has a treatment that suits a header rather than a list.

const WIZARD: Stepper.Model = {
  steps: [
    step("Machine", null),
    step("Details", null),
    step("Connect", null),
    step("Approve", null),
  ],
};

const WIZARD_MIDFLIGHT: Stepper.Model = {
  steps: [
    { ...step("Machine", null), marker: "✓", tone: "var(--green)" },
    { ...step("Details", null), marker: "✓", tone: "var(--green)" },
    { ...step("Connect", null), current: true },
    step("Approve", null),
  ],
};

const WIZARD_DASHED: Stepper.Model = {
  steps: [
    { ...step("Announce", null), railAfter: "dashed" },
    step("Compare", null),
    step("Approve", null),
  ],
};

const WIZARD_CROWDED: Stepper.Model = {
  steps: [
    step("Machine", null),
    step("Name it and choose the ssh account", null),
    step("Open the window", null),
    step("Compare fingerprints", null),
  ],
};

// The other way to say "here": the steps behind the reader dimmed rather than
// left at full strength, and the current mark lifted off the ground instead of
// ringed. Same model, same component, two knobs and a per-step flag.
const WIZARD_DIMMED: Stepper.Model = {
  steps: [
    { ...step("Machine", null), marker: "✓", tone: "var(--green)", muted: true },
    { ...step("Details", null), marker: "✓", tone: "var(--green)", muted: true },
    { ...step("Connect", null), current: true },
    step("Approve", null),
  ],
};

const MARK16 = {
  "--step-marker-size": "16px",
  "--step-marker-font-size": "var(--text-7px)",
};

function $row(model: Stepper.Model, vars: Record<string, string>): StepperHorizontal {
  const $s = StepperHorizontal.makeWith(model);
  $s.style.width = WIDTH;
  for (const [k, v] of Object.entries(vars)) $s.style.setProperty(k, v);
  return $s;
}

export class StepperHorizontalStoryBook extends Storybook.Default {
  title(): string {
    return "Stepper, horizontal (std-stepper-horizontal)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "A wizard's progress header",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Four steps at the 16px mark the add-host modal uses. The cells are " +
        // "equal width, so the marks land on a regular pitch and every rail " +
        // "between them is one length; there is no rail after the last step.",
        render: () => $row(WIZARD, MARK16),
      },
      {
        title: "Mid-flight",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Done, current, pending. `marker` and `tone` mark the two behind and " +
        // "`current` marks the one being read — the same per-step fields the " +
        // "column uses, given the treatment a header wants rather than the " +
        // "one a list wants. A done step keeps its title at full strength: it " +
        // "is history, not something switched off, and dimming it under a " +
        // "bright green tick says two contradictory things about one step.",
        render: () => $row(WIZARD_MIDFLIGHT, MARK16),
      },
      {
        title: "Dimmed behind, lifted at the front",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The same three states in the other register. `muted` quiets what " +
        // "is BEHIND the reader and only that — a step not reached yet is " +
        // "not history, and greying it would say it was skipped rather than " +
        // "that it is coming. In a row muted quiets the MARK as well as the " +
        // "title, which the column does not do. The current mark is lifted " +
        // "rather than ringed, on `--surface-shadow` — the same lift " +
        // "`std-round` puts under every card surface — and the ring is turned " +
        // "off here because running both says \"here\" twice.",
        render: () =>
          $row(WIZARD_DIMMED, {
            ...MARK16,
            // No outline at all, not a quieter one: the lift IS the
            // statement, and an outline under it — blue or grey — is the
            // second one this card exists to argue against.
            "--step-marker-border-current": "none",
            "--step-marker-color-current": "var(--text-pri)",
            "--step-marker-shadow-current": "var(--surface-shadow)",
          }),
      },
      {
        title: "A dashed rail",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "`railAfter: \"dashed\"` is a discontinuity in the sequence, and it " +
        // "turns with the layout — the repeating gradient runs left to right " +
        // "here and top to bottom in the column, from the same knob.",
        render: () => $row(WIZARD_DASHED, MARK16),
      },
      {
        title: "Titles fighting for the cell",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Each cell is `flex: 1 1 0` with a zero min-width, so a long title " +
        // "wraps inside its own cell instead of forcing the row wider than its " +
        // "container. The marks stay on their pitch and the rails stay on the " +
        // "marks' line whatever the titles below do.",
        render: () => $row(WIZARD_CROWDED, MARK16),
      },
    ];
  }
}
