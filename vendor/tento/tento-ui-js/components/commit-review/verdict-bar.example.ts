import { Storybook } from "../../ui/storybook";
import { VerdictBar } from "./verdict-bar";

// Storybook for the floating verdict UI. The bar is an OVERLAY: its host is a
// statically-sized anchor whose absolutely-positioned surface pins to the
// bottom edge, so it only lays out inside a positioned box of a known width —
// in the pane that is `#verdict` (position: absolute, width: min(560px, …)).
// Each card reproduces exactly that much and nothing else: the width and the
// containing block are the owner's job by the component's own contract, not
// decoration. Everything above the bar in a card is the anchor's real height
// (the expanded card's), which is why a collapsed example looks bottom-heavy —
// that space is where it morphs into.

/** A fixed epoch, not `Date.now()`: a verdict timestamp is displayed prose, and
 * a story that re-renders to a different string is a story that cannot be
 * compared against yesterday's. 2026-01-14 09:20 UTC. */
const REVIEWED_AT = 1768382400;

/** The bar at the pane's shipped width, in a containing block it can pin to. */
function $bar(): VerdictBar {
  const $v = VerdictBar.make();
  $v.style.position = "relative";
  $v.style.width = "560px";
  return $v;
}

/** Not yet reviewed, and this host may vote: the composer and all three
 * actions are live. `onSubmit` echoes the verdict back the way the pane's
 * persistence does, so approving in the card really does re-bind the bar and
 * collapse it — the whole morph is exercisable here. */
function $pending(): HTMLElement {
  const $v = $bar();
  $v.bind({ status: "pending", summary: "", reviewed_at: 0 });
  $v.onSubmit = (r) =>
    Promise.resolve({ status: r.status, summary: r.summary, reviewed_at: REVIEWED_AT });
  $v.setCommentSink(() => Promise.resolve());
  return $v;
}

/** A verdict already on the record. The collapsed bar carries the status dot;
 * the pill and the timestamp live in the expanded card, so this one is worth
 * opening. The composer is empty on purpose — the summary that was submitted
 * is on the record and reads in the discussion log, and a composer pre-filled
 * with it would invite posting it twice. */
function $approved(): HTMLElement {
  const $v = $bar();
  $v.bind({
    status: "approved",
    summary: "Ships. The trailer parse is the right seam.",
    reviewed_at: REVIEWED_AT,
  });
  $v.onSubmit = (r) =>
    Promise.resolve({ status: r.status, summary: r.summary, reviewed_at: REVIEWED_AT });
  $v.setCommentSink(() => Promise.resolve());
  return $v;
}

/** Mirrored: a draft replayed onto this host from another machine, so this
 * host cannot vote on it. Both layers are wired exactly as the pane wires them
 * — including the comment sink, which the read-only mode has to override
 * rather than merely happen not to be given.
 *
 * `expanded` is set as an attribute because that attribute IS the component's
 * layer contract (`:host([expanded])` drives the morph). It is set AFTER
 * `setMirroredFrom`, which collapses the bar on its way in. */
function $mirrored(expanded: boolean): HTMLElement {
  const $v = $bar();
  $v.bind({ status: "pending", summary: "", reviewed_at: 0 });
  $v.onSubmit = (r) =>
    Promise.resolve({ status: r.status, summary: r.summary, reviewed_at: REVIEWED_AT });
  $v.setCommentSink(() => Promise.resolve());
  $v.setMirroredFrom("jameskao@laptop");
  $v.toggleAttribute("expanded", expanded);
  return $v;
}

export class VerdictBarStoryBook extends Storybook.Default {
  title(): string {
    return "VerdictBar (std-verdict-bar)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Pending — live: click the bar to open the card",
        render: () => $pending(),
      },
      {
        title: "Approved — the pill and the time are in the card",
        render: () => $approved(),
      },
      {
        title: "Mirrored, collapsed — the notice is the whole bar",
        render: () => $mirrored(false),
      },
      {
        title: "Mirrored, expanded — controls gone, not greyed",
        render: () => $mirrored(true),
      },
    ];
  }
}
