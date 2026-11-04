import { Storybook } from "../../ui/storybook";
import { StateParser } from "../../review-dsl/state-parser";
import { ReviewState } from "./review-state";

function $state(src: string): HTMLElement {
  const r = StateParser.parse(src);
  if (!r.ok) {
    throw new Error(`fixture failed: line ${r.error.line}: ${r.error.message}`);
  }
  const $el = ReviewState.make();
  $el.bind({ machine: r.value });
  return $el;
}

const SET_LIFECYCLE = `stateDiagram-v2
  [*] --> Queued
  Queued --> Staged: temp-index apply
  Staged --> Drained: commit ::new
  Staged --> Conflict: 3way fails
  Conflict --> Queued: rebase + requeue
  Drained --> [*]
  class Conflict changed`;

const RETIRED_PATH = `stateDiagram-v2
  [*] --> Draft
  Draft --> Public: push
  Draft --> Orphaned: sha rekey ::removed
  Orphaned --> Draft: cid fallback ::new
  Public --> [*]`;

const LONG_LABELS = `stateDiagram-v2
  [*] --> WaitingForTheRemoteReviewRecordToFinishLoading
  WaitingForTheRemoteReviewRecordToFinishLoading --> ShowingTheResolvedChangeAcrossAConstrainedColumn: association by stable Change-Id without box overlap
  ShowingTheResolvedChangeAcrossAConstrainedColumn --> [*]`;

export class ReviewStateStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewState (std-review-state)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Queue-set lifecycle",
        render: () => $state(SET_LIFECYCLE),
      },
      {
        title: "Removed vs added transitions",
        render: () => $state(RETIRED_PATH),
      },
      {
        title: "Long state and transition labels",
        render: () => $state(LONG_LABELS),
      },
    ];
  }
}
