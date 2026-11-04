import { Storybook } from "../../ui/storybook";
import { RevisionCompare } from "./revision-compare";

// Storybook for the revision compare control — the interdiff picker pair. The
// card in a commit note shows the component only.
//
// In the app this lives in std-record-header's trailing slot, right-aligned on
// the title line. Here it stands alone, which is the honest way to show what
// the component itself is: a single row, no block of its own.

// One hour apart, oldest first — `captured_at` is unix SECONDS. The control
// itself never reads it (it lists revisions by `n` and `trigger`); the
// discussion log does.
function revs(...ns: number[]): RevisionCompare.Revision[] {
  const now = Math.floor(Date.now() / 1000);
  return ns.map((n) => ({
    n,
    trigger: n === 1 ? "initial" : "revise",
    captured_at: now - (ns.length - n) * 3600,
  }));
}

/** Four revisions with a changes_requested at diff 2. Compare preselects
 *  "since my last changes_requested" → current, so it opens on 2 → 4. */
const NEEDS_REVISION: RevisionCompare.ViewModel = {
  revisions: revs(1, 2, 3, 4),
  current: 4,
  changesRequestedAt: 2,
};

/** No open request-for-changes: the default falls back to the previous
 *  revision → current, so it opens on 2 → 3. */
const CLEAN: RevisionCompare.ViewModel = {
  revisions: revs(1, 2, 3),
  current: 3,
  changesRequestedAt: null,
};

/** Mixed triggers, so the picker rows have something to distinguish. Open
 *  either picker to see `diff 3 · absorb` — the fact the deleted dots used to
 *  hide behind a hover tooltip. */
const MIXED: RevisionCompare.ViewModel = {
  revisions: [
    { n: 1, trigger: "initial", captured_at: 1786000000 },
    { n: 2, trigger: "revise", captured_at: 1786003600 },
    { n: 3, trigger: "absorb", captured_at: 1786007200 },
    { n: 4, trigger: "note-only", captured_at: 1786010800 },
  ],
  current: 4,
  changesRequestedAt: null,
};

/** Nothing to compare. The control hides itself rather than render a picker
 *  with one entry — this example is here to show that it renders nothing, not
 *  to show a bug. */
const SINGLE: RevisionCompare.ViewModel = {
  revisions: revs(1),
  current: 1,
  changesRequestedAt: null,
};

export class RevisionCompareStoryBook extends Storybook.Default {
  title(): string {
    return "RevisionCompare (std-revision-compare)";
  }

  description(): Option<string> {
    return (
      "Pick two captured revisions and render their interdiff. Lives in " +
      "std-record-header's trailing slot; self-hides below two revisions."
    );
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Needs revision (CR at diff 2)",
        render: () => RevisionCompare.makeWith(NEEDS_REVISION),
      },
      { title: "Clean history", render: () => RevisionCompare.makeWith(CLEAN) },
      {
        title: "Mixed triggers (open a picker)",
        render: () => RevisionCompare.makeWith(MIXED),
      },
      {
        title: "One revision — hidden",
        render: () => RevisionCompare.makeWith(SINGLE),
      },
    ];
  }
}
