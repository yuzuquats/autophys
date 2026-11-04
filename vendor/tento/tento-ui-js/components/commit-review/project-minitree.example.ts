import { Storybook } from "../../ui/storybook";
import { ProjectMinitree } from "./project-minitree";

// Storybook for the project minitree — one project's arc as a single-lane
// tree: queued sets, planning commits, drafts, then landed history with an
// inert older-tail, under its own section header. The card in a commit note
// shows the component only.
//
// Both examples are ruleless of their own accord: the header's rule and the
// rows' left edge are the section's whole boundary now, so a card that framed
// them would be reviewing a frame the component no longer draws.

function $minitree(model: ProjectMinitree.Model): ProjectMinitree {
  const $el = ProjectMinitree.make();
  $el.bind(model);
  return $el;
}

/** A full arc: two drafts (one under review, one accepted, one a planning
 *  commit), then landed history newest-first, then the inert older-tail. The
 *  third row is `current` to show the pane's you-are-here marker. */
const ARC: ProjectMinitree.Model = {
  rows: [
    {
      kind: "draft",
      label: "feat(commit-review): project minitree",
      state: "changes_requested",
      key: "local:3",
      handle: "L-148",
      current: true,
    },
    {
      kind: "planning",
      label: "plan: two-audience commit messages",
      state: "approved",
      key: "local:2",
      handle: "L-147",
      current: false,
    },
    {
      kind: "draft",
      label: "feat(review-notes): std-review-html",
      state: "approved",
      key: "local:1",
      handle: "L-140",
      current: false,
    },
    {
      kind: "landed",
      label: "feat(review): std-storybook-card tag",
      state: null,
      key: null,
      handle: "D-6120",
      current: false,
    },
    {
      kind: "landed",
      label: "feat(review-notes): review-flow, review-seq",
      state: null,
      key: null,
      handle: "D-6098",
      current: false,
    },
  ],
  olderCount: 12,
};

/** A queued set with no landed history yet — the minimal shape the section
 *  renders (a null/empty model hides it entirely, so there is nothing to
 *  show for the hidden case). */
const FRESH: ProjectMinitree.Model = {
  rows: [
    {
      kind: "queued",
      label: "chore(sdk): freeze the 2.0 surface",
      state: "pending",
      key: "local:0",
      handle: null,
      current: true,
    },
  ],
  olderCount: 0,
};

export class ProjectMinitreeStoryBook extends Storybook.Default {
  title(): string {
    return "ProjectMinitree (std-project-minitree)";
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Full arc", render: () => $minitree(ARC) },
      { title: "Fresh project", render: () => $minitree(FRESH) },
    ];
  }
}

// → review-notes would cycle), so name it from here at module scope.
