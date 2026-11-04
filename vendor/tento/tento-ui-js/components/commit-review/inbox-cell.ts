import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { $inboxPips, InboxPip } from "./inbox-pips";
import { StackLog } from "./stack-log";

// The inbox's primary cell — medallion (⇄ chevron on hover), title, caption
// line. Its own component because a table cell is mounted inside
// `std-table-body`'s shadow root, out of reach of the inbox's stylesheet —
// Typography and the medallion palette included.
//
// A PRIMITIVE, deliberately: it binds a presentational [`InboxCell.Model`]
// rather than the inbox's own row type, so nothing here knows about turns,
// holds, fields or placements — the inbox computes those into `quiet` and
// the pre-formatted `caption` fragments before handing the model over. That
// is also what makes the component reviewable alongside its storybook
// (`inbox-cell.example.ts`): an example fabricates a model, not an inbox.

/** The primary cell's icon slot geometry — exported because the inbox's
 * divider inset math starts the hairline exactly where this puts the text,
 * and the two numbers must not be allowed to drift apart. */
export const ICON_W = 16;
export const ICON_GAP = 7;
/** Child rows sit one medallion in. */
export const CHILD_INDENT = 13;

/** The rail's medallion palette. Duplicated into every shadow root that
 * draws one (the minitree already does the same) — shapes come classed from
 * StackLog.$node, color = state, hollow = container/plan, and ready rides
 * --purple-fg for the stroke-legibility reason stack-log documents.
 * Exported: the inbox's compact strip draws the same medallions in its own
 * shadow root. */
export const $nodePalette = css`
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
  .node.ready {
    fill: var(--purple-fg);
  }
  .node.hollow {
    fill: none;
    stroke: var(--text-ter);
    stroke-width: 1.4;
  }
  .node.hollow.pending {
    stroke: var(--yellow);
  }
  .node.hollow.approved {
    stroke: var(--green);
  }
  .node.hollow.changes_requested {
    stroke: var(--red);
  }
  .node.hollow.ready {
    stroke: var(--purple-fg);
  }
`;

/** How far the caption's id sits below the prose it shares a line with.
 * A multiplier, not a token — see [`StackLog.$handleLink`]. 0.9 of the
 * caption's 12.5px computed size lands at ~11.25px: a step down that reads as
 * secondary without dropping under the rail's legibility floor. */
const CAPTION_ID_SCALE = 0.9;

@component({ name: "std-review-inbox-cell" })
export class InboxCell extends LonaWebComponent {
  private $med: HTMLElement = this.$("med");
  private $icon: HTMLElement = this.$("icon");
  private $title: HTMLElement = this.$("title");
  private $sub: HTMLElement = this.$("sub");

  /** Set per bind: the disclosure was clicked. Null on a row that cannot
   * open, which is also what lets the click fall through to selection. */
  private onToggle: Option<() => void> = null;
  /** The row this cell last attached its hover listeners to. */
  private $boundRow: Option<HTMLElement> = null;

  constructor() {
    super();
    // Nested inside the row's own click handler. GESTURE_MANAGER stops
    // propagation at the innermost registered element, so this claims the
    // disclosure hit area and the row keeps every other pixel — the split
    // affordance stack-log's container rows already teach.
    GESTURE_MANAGER.addPointerEvent(this.$icon, {
      onClick: () => this.onToggle?.(),
    });
  }

  bind(model: InboxCell.Model, $row: HTMLElement, onToggle: Option<() => void>): void {
    this.onToggle = onToggle;
    this.toggleAttribute("child", model.child);
    // The indent is a number of levels, not a boolean: a master project's
    // roll nests member projects under it and their commits under those, so
    // the rail needs two depths, not one. Written as a custom property
    // because CSS cannot do arithmetic on an attribute.
    this.style.setProperty("--indent", `${Math.max(0, model.depth) * CHILD_INDENT}px`);
    this.toggleAttribute("quiet", model.quiet);
    this.toggleAttribute("expandable", model.expandable);
    this.toggleAttribute("expanded", model.expanded);
    this.toggleAttribute("row-hover", false);

    const cls = model.hollow
      ? `node hollow ${model.status}`
      : `node ${model.status}`;
    this.$med.replaceChildren(StackLog.$node(model.shape, cls, false));
    this.$title.textContent = model.title;

    // Blocked is not a caption fragment the caller can drop: it is the one
    // thing the medallion palette cannot say, so it rides the caption
    // unconditionally — and brings the caption line into existence when
    // nothing else fills it.
    this.$sub.replaceChildren();
    if (model.caption.length === 0 && model.pips.length === 0 && !model.blocked) {
      this.toggleAttribute("one-line", true);
    } else {
      this.toggleAttribute("one-line", false);
      // Fragments, not one joined string: the `id` fragment is an address and
      // renders as a link, so the separators have to be built rather than
      // joined in.
      model.caption.forEach((frag, i) => {
        if (i > 0) this.$sub.append(" · ");
        // The id recedes a step from the prose beside it: on a 300px rail the
        // caption reads "mono · 1 plan · L-142", and the name is the least
        // urgent thing on that line — the title above it is what the eye is
        // scanning, and the id is what it lands on once it has stopped.
        this.$sub.append(
          frag.href == null
            ? frag.text
            : StackLog.$handleLink(frag.text, frag.href, CAPTION_ID_SCALE),
        );
      });
      if (model.pips.length > 0) {
        if (model.caption.length > 0) this.$sub.append(" · ");
        this.$sub.appendChild($inboxPips(model.pips));
      }
      if (model.blocked) {
        const $b = document.createElement("span");
        $b.className = "blocked";
        $b.textContent =
          model.caption.length > 0 || model.pips.length > 0 ? " · ⚠ blocked" : "⚠ blocked";
        this.$sub.appendChild($b);
      }
    }

    // True ROW hover, not cell hover: cells are absolutely positioned per
    // column, so `:host(:hover)` would only fire over the title column.
    if (this.$boundRow != null && this.$boundRow !== $row) {
      this.$boundRow.removeEventListener("pointerenter", this.enter);
      this.$boundRow.removeEventListener("pointerleave", this.leave);
    }
    this.$boundRow = $row;
    $row.addEventListener("pointerenter", this.enter);
    $row.addEventListener("pointerleave", this.leave);
  }

  private enter = (): void => {
    this.toggleAttribute("row-hover", true);
  };
  private leave = (): void => {
    this.toggleAttribute("row-hover", false);
  };

  // The call form, not the tag: `css` the tag drops interpolated values
  // (it stringifies only the literal parts), and this block interpolates
  // the shared icon-slot constants.
  static $styles = [
    Typography.$style,
    StackLog.HANDLE_CSS,
    $nodePalette,
    css(`
      :host {
        display: flex;
        align-items: center;
        width: 100%;
        min-width: 0;
      }
      /* Slot geometry comes from the shared constants: the divider inset
         math starts the hairline exactly where this puts the text. */
      #icon {
        position: relative;
        display: flex;
        flex: none;
        width: ${ICON_W}px;
        height: ${ICON_W}px;
        margin-right: ${ICON_GAP}px;
        align-items: center;
        justify-content: center;
      }
      /* Child rows sit one medallion in per level, so a project's members
         read as belonging to it rather than as more projects — and a master
         project's member projects nest one level deeper again. */
      #icon {
        margin-left: var(--indent, 0px);
      }
      #med {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #med svg {
        width: 12px;
        height: 12px;
        display: block;
        overflow: visible;
      }
      /* The medallion is the resting truth; the chevron is only what the
         pointer offers. Rows with no members never swap. */
      #chev {
        position: absolute;
        width: 12px;
        height: 12px;
        display: none;
        fill: var(--text-sec);
        transition: transform 0.12s ease;
      }
      :host([expandable][row-hover]) #med {
        visibility: hidden;
      }
      :host([expandable][row-hover]) #chev {
        display: block;
      }
      :host([expandable][expanded]) #chev {
        transform: rotate(90deg);
      }
      :host([expandable]) #icon {
        cursor: pointer;
      }
      #body {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
        /* 6px, ruled by eye (operator round 6). The trim makes this the
           LITERAL baseline-to-cap distance, so it reads far tighter than the
           number suggests: 2px looked like the lines touching, 4px still
           crowded. */
        gap: 6px;
      }
      /* Typography's cap-height trim is what makes the gap mean something:
         the negative block margins strip the leading off both lines, so the
         column's gap IS the distance from the title's baseline to the
         caption's cap. Pinning the margin inputs to 0px keeps that true —
         they INHERIT, so a list style further up would otherwise leak a
         second, invisible gap on top of this one. */
      #title,
      #sub {
        --margin-top: 0px;
        --margin-bottom: 0px;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #title {
        color: var(--text-pri);
      }
      :host([quiet]) #title,
      :host([child]) #title {
        color: var(--text-sec);
      }
      #sub {
        color: var(--text-ter);
      }
      :host([one-line]) #sub {
        display: none;
      }
      .blocked {
        color: var(--orange);
      }
    `),
  ];

  // The chevron path is the accordion caret stack-log's container rows use,
  // redrawn here because shadow roots share no styles and stack-log keeps
  // its factory private.
  static $html: Option<HTMLTemplateElement> = html`
    <span id="icon">
      <span id="med"></span>
      <svg id="chev" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"></path>
      </svg>
    </span>
    <span id="body">
      <p id="title" class="caption"></p>
      <p id="sub" class="small"></p>
    </span>
  `;
}

export namespace InboxCell {
  /** Everything the cell renders, already decided. The inbox folds its turn
   * model, hold set and field placements into `quiet` and the pre-formatted
   * `caption` fragments — this component only paints. */
  export type Model = {
    title: string;
    /** Caption fragments in display order, joined with " · ". Empty (with
     * `blocked` false) collapses the cell to its one-line form. */
    /** The caption fragments, in order, already formatted by the owner. A
     * fragment with an `href` is an id and draws as a link. */
    caption: { text: string; href: Option<string> }[];
    /** Constituent project commits, rendered after the textual fragments. */
    pips: InboxPip[];
    /** Renders an unconditional "⚠ blocked" caption suffix. */
    blocked: boolean;
    shape: StackLog.NodeShape;
    hollow: boolean;
    status: StackLog.ProjectStatus | StackLog.State;
    /** A member row spliced under an open project: indented, secondary title
     * color. */
    child: boolean;
    /** How many levels in the row sits — 0 top level, 1 a project's own
     * commit, 2 a commit of a member project nested under a master project. */
    depth: number;
    /** Parked or not-your-turn rows read quiet whatever their state says. */
    quiet: boolean;
    /** Hovering swaps the medallion for the disclosure chevron. */
    expandable: boolean;
    expanded: boolean;
  };
}
