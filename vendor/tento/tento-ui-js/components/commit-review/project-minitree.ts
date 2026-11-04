import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";
// VALUE imports, not `import type`: they are what register the two elements
// the template names, and a type-only import would leave both inert.
import { SectionHead } from "../section-head";
import { Stepper } from "../stepper";
import { StackLog } from "./stack-log";

// The project minitree: one project's arc — queued sets, planning commits,
// drafts, and landed history — as a section in the review pane. It reuses the
// rail's node medallion vocabulary (hollow square = queued, hollow triangle =
// planning, circle = draft, diamond = landed) so the two trees read as one
// system.
//
// The column itself is `std-stepper`, not this file. What used to be here was
// a second implementation of a marked vertical list: an SVG canvas per row, a
// `lane()` helper computing `y1`/`y2` percentages, and a rule that a lane must
// stop at 35% and resume at 65% so it does not cross an unfilled shape. All of
// that is gone, and the last of it is worth recording because it was work the
// geometry does for free: the stepper's rail runs from one mark's BOTTOM edge
// to the next mark's TOP edge, so it never crosses a mark at all and the
// hollow-shape gap has nothing left to solve.
//
// What this component still owns is what a std-stepper has no opinion about:
// which medallion a row kind gets, the dense register the review pane reads at,
// and the section's own identity line.
//
// It is a SECTION, not a card. The bordered frame it used to draw made it a
// third genre wedged between the note's Comments and the Discussion below —
// two regions that carry their identity in a header and their boundary in a
// rule.
//
// The component never fetches: the owner assembles the model from the
// already-loaded stack/queue plus the project-history endpoint. Rows whose
// commit is present in the rail carry that rail key — clicking reports through
// `onSelect` (same delegation contract as std-stack-log); rows without a key
// (older landed history, unavailable hosts) are inert.

@component({ name: "std-project-minitree" })
export class ProjectMinitree extends LonaWebComponent {
  private $head: SectionHead = this.hydrate("head");
  private $steps: Stepper = this.hydrate("steps");

  /** Set by the owner: a navigable row was clicked (`key` is a rail key). */
  onSelect: Option<(key: StackLog.Key) => void> = null;

  /** Set by the owner: the app's own URL for a row key. Each row's handle is
   * drawn through it, so a landed commit no longer in the rail's public page
   * is still addressable even though the row itself is inert. */
  hrefOf: Option<(key: StackLog.Key) => Option<string>> = null;

  constructor() {
    super();
    // One line, where there used to be a pointer handler, a target test and a
    // `closest(".row[data-key]")`: selection is the stepper's contract now, and
    // this only forwards it.
    this.$steps.onSelect = (key) => this.onSelect?.(key);
  }

  /** Null (or an empty model) hides the section entirely — the header goes
   * with it. A header is reserved space, and reserved space with nothing under
   * it is a hole, not an empty region; the whole section leaves instead. */
  bind(model: Option<ProjectMinitree.Model>): void {
    if (model == null || model.rows.length === 0) {
      this.$steps.bind({ steps: [] });
      this.toggleAttribute("shown", false);
      return;
    }
    this.toggleAttribute("shown", true);
    // Inside bind, not the constructor: a recycled instance comes back with
    // its title cleared, and a header bound once would come back empty.
    //
    // Lower case, matching the pane's `plan` and `members` — the two headers
    // this one is sandwiched BETWEEN when the pane renders the arc as its
    // no-plans fallback. Case across the review's headers is inherited rather
    // than decided, and choosing one for all of them is its own change. No
    // count: it would be a count of commits under a title that says `project`,
    // which reads as a number of projects.
    this.$head.bind({ title: "project", count: null });
    this.$steps.bind({ steps: this.steps(model) });
  }

  /** The arc as stepper steps. Pure but for `hrefOf`, which only the owner
   * can answer. */
  private steps(model: ProjectMinitree.Model): Stepper.Step[] {
    const last = model.rows.length - 1;
    const steps = model.rows.map((row, i): Stepper.Step => ({
      // An ELEMENT marker, so the stepper places it and draws nothing around
      // it. These medallions already say kind by silhouette and state by
      // colour; a stepper circle behind one would be a second, contradicting
      // shape claiming the same job.
      marker: StackLog.$node(SHAPE[row.kind], nodeClass(row), false),
      title: row.label,
      meta: this.$handle(row),
      body: null,
      tone: null,
      current: row.current,
      // Landed history reads quieter than the drafts above it — the same
      // distinction the old `.row.landed .label` drew, now a step's own state
      // rather than a class this file styles.
      muted: row.kind === "landed",
      railAfter: i === last && model.olderCount > 0 ? "dashed" : "solid",
      key: row.key,
    }));
    if (model.olderCount > 0) {
      // The endpoint page is bounded, and the overflow is a real part of the
      // arc rather than a footnote about it: an inert step with NO mark, under
      // a dashed rail. The rail still stops where a mark would have been, so
      // the column does not close early.
      steps.push({
        ...Stepper.plain(`⋯ ${model.olderCount} older`, null),
        marker: null,
        muted: true,
        railAfter: "none",
      });
    }
    return steps;
  }

  /** The row's short name, at the row's far end. A keyless row stays plain
   * text: its handle is a real name and would make a real-looking link, but
   * nothing resolves a commit that is neither a draft nor on the loaded public
   * page — that is the `/d/` permalink route, and a link that lands on the
   * default row would be worse than no link. */
  private $handle(row: ProjectMinitree.Row): Option<HTMLElement> {
    if (row.handle == null) return null;
    // A ramp element, not a bare span. `--font-size` on a span sets a variable
    // nothing reads: `span` is not in the typography ramp's selector list, so
    // the wrapper keeps whatever font-size it inherits — 13.89px from the
    // stepper's row — and, being the tallest thing in the row, it was what
    // pushed a 24px row to 28.7px. The link inside is an `a` when it has an
    // href and a `span` when it does not (`$handleLink`), so the wrapper is the
    // only place that reliably carries the size for both.
    const $id = Typography.p("");
    $id.className = "handle";
    $id.appendChild(
      StackLog.$handleLink(
        row.handle,
        row.key == null ? null : (this.hrefOf?.(row.key) ?? null),
      ),
    );
    return $id;
  }

  static $styles = [
    StackLog.HANDLE_CSS,
    css`
      :host {
        display: none;
      }
      /* The section's own air, matching std-discussion below it — a section
         owns the space above itself, because only the section knows it is
         starting. */
      :host([shown]) {
        display: block;
        margin-top: 18px;
      }

      /* The dense register, as the stepper's own inputs. Every number is one
         the hand-rolled version already had; none of them is a position.

         --step-pad-y is 6px because that is what puts a 12px medallion in the
         middle of a 24px row, and the rail's ends are computed from it — the
         old code wrote the same relationship as top:50% / y1:65% in four
         places and had to keep them agreeing. */
      #steps {
        --step-marker-size: 12px;
        --step-pad-x: 6px;
        --step-pad-y: 6px;
        --step-gap: 6px;
        /* 1px, not 0: these rows are selectable, so each one paints its own
           hover background, and at zero spacing two adjacent hovers share an
           edge — the highlight reads as one block spanning both rows rather
           than as the row under the pointer. One pixel is enough to separate
           them and is invisible otherwise.

           The rail does not care: its lower end is pinned to the NEXT mark's
           top through --step-pad-y, not to the spacing, so the gap can move
           without opening a hole in the line. */
        --step-spacing: 1px;
        /* Breathing room the old rail never had — the handle used to sit flat
           against the right edge of its own hover background. */
        --step-pad-right: 8px;
        --step-rail-width: 1.5px;
        --step-mark-align: flex-start;
        --step-title-size: var(--text-8px);
        --step-title-leading: 1.1;
        --step-title-wrap: nowrap;
        --step-meta-size: var(--text-7px);
        padding-top: 8px;
      }

      /* The handle is monospace and quiet — the one piece of type the stepper
         does not decide, because it is a NAME rather than a size.

         These rules reach the element because the stepper SLOTS an element
         mark and an element meta rather than adopting them: they stay in this
         component's light DOM, under this stylesheet. Adopted, they would land
         in the stepper's shadow root and arrive with no fill, no stroke and no
         hover — the medallions in particular would render solid black. */
      /* Sized HERE, not by the stepper's .step-meta. A slotted child stays
         in this tree, so .step-meta lands on the slot and never reaches
         it — what reaches it is the base ramp's bare A rule, which hands it
         --p-size. Left alone it rendered at 13.89px and was the tallest thing
         in the row, which is what pushed a 24px row to 28.7px. */
      .handle,
      .handle a,
      .handle span {
        --font-size: var(--text-7px);
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
        font-family: var(--mono, monospace);
        color: var(--text-ter);
      }

      /* StackLog.$node draws a viewBox and no width/height, so the medallion
         has always taken its size from CSS — it rendered 0x0 until this rule
         existed. It reads the stepper's own marker size rather than repeating
         12px: the SVG is a light-DOM child of the std-stepper, so the value set
         on that element inherits straight into it, and the mark can never end
         up a different size from the column reserved for it.

         The old rule also absolutely positioned this at left:12px top:50%
         with a translate to re-centre. None of that is here: placing the mark
         is the stepper's job now, and .step-mark is the box that does it. */
      .node-svg {
        display: block;
        width: var(--step-marker-size);
        height: var(--step-marker-size);
        overflow: visible;
      }

      /* The medallion vocabulary, unchanged from the rail: shape says kind,
         colour says review state, hollow says "not a commit yet". */
      .node {
        fill: var(--text-ter);
        stroke: none;
      }
      .node.pending {
        fill: var(--yellow);
      }
      .node.approved {
        fill: var(--green);
      }
      .node.changes_requested {
        fill: var(--red);
      }
      .node.hollow {
        fill: none;
        stroke: var(--text-ter);
        stroke-width: 1.4;
      }
      .node.hollow.pending {
        fill: none;
        stroke: var(--yellow);
      }
      .node.hollow.approved {
        fill: none;
        stroke: var(--green);
      }
      .node.hollow.changes_requested {
        fill: none;
        stroke: var(--red);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <std-section-head id="head"></std-section-head>
      <std-stepper id="steps"></std-stepper>
    </div>
  `;
}

/** The medallion silhouette for each row kind — the rail's vocabulary,
 * unchanged. */
const SHAPE: Record<ProjectMinitree.RowKind, StackLog.NodeShape> = {
  queued: "square",
  planning: "triangle",
  draft: "circle",
  landed: "diamond",
};

/** Hollow kinds are not yet commits: a queued set and a planning commit are
 * containers for work rather than the work. Filled kinds are the work. */
const HOLLOW: Record<ProjectMinitree.RowKind, boolean> = {
  queued: true,
  planning: true,
  draft: false,
  landed: false,
};

function nodeClass(row: ProjectMinitree.Row): string {
  const hollow = HOLLOW[row.kind] ? "node hollow" : "node";
  return row.state != null ? `${hollow} ${row.state}` : hollow;
}

export namespace ProjectMinitree {
  export type RowKind = "queued" | "planning" | "draft" | "landed";

  export type Row = {
    kind: RowKind;
    /** The commit subject / set message. */
    label: string;
    /** Review state colors the node; null (landed history) stays gray. */
    state: Option<StackLog.State>;
    /** Rail key when the commit is navigable in the current rail (fleet
     * keys carry their host prefix); null = inert row. */
    key: Option<StackLog.Key>;
    /** The row's short name: its handle (`L-142` / `D-6098`), or a sha9 for a
     * commit the ledger never numbered. Null on a row that names no commit
     * (a queued set, an error line). */
    handle: Option<string>;
    /** The commit the pane is currently showing. */
    current: boolean;
  };

  /** Rows in stack order, top → bottom: queued → drafts (planning among
   * them) → landed newest-first. `olderCount` > 0 appends the inert tail.
   *
   * No slug: the section header names the region, and the project's NAME is
   * already on screen — the rail's node row, and the pane header when the
   * pane renders this as its no-plans fallback. */
  export type Model = { rows: Row[]; olderCount: number };
}
