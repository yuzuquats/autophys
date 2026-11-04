import { Storybook } from "../ui/storybook";
import { RecordHeader } from "./record-header";

// Storybook for the record header. An example fabricates a view model, not a
// review pane — the card in a commit note shows this component and nothing
// wrapped around it.
//
// Note what none of these examples do: set --pane-pad. The full-bleed rule is
// opt-in (--record-header-bleed defaults to 0), so a header shown outside a
// padded scroller draws its hairline edge to edge of ITSELF, which is what a
// card should show. A caller who wants the bleed publishes --pane-pad, and the
// review shells do.

/** A stand-in state marker. The real callers hand in the rail's own pip
 *  ($inboxPip) so the header and the sidebar can never disagree about a
 *  colour; the card draws its own circle instead, because an example must not
 *  reach into the commit-review surface to render one dot. */
function marker(color: string, hollow: boolean = false): Node {
  // 14px, the size the review shells ask $inboxPip for on this line — twice
  // the rail's 7px, because here the pip is alone rather than one of a strip
  // and has no neighbours to be read against.
  const $svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  $svg.setAttribute("viewBox", "0 0 12 12");
  $svg.setAttribute("aria-hidden", "true");
  $svg.style.cssText = "display:block;height:14px;width:14px;overflow:visible";
  const $c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  $c.setAttribute("cx", "6");
  $c.setAttribute("cy", "6");
  $c.setAttribute("r", hollow ? "3.8" : "4.4");
  $c.style.fill = hollow ? "none" : color;
  $c.style.stroke = hollow ? color : "none";
  $c.style.strokeWidth = hollow ? "2" : "0";
  $svg.appendChild($c);
  return $svg;
}

/** A record's address, as the review surface renders it: a handle that links
 * to the row it names. Built here as a bare anchor — the point of `Sub` taking
 * nodes is that the header never has to know how one is made. */
function handle(text: string): Node[] {
  const $a = document.createElement("a");
  $a.className = "handle";
  $a.textContent = text;
  $a.href = "#";
  // What StackLog.$handleLink does, and for the reason documented there: the
  // shared typography rule retypesets a bare <a> as a PARAGRAPH, so a handle
  // that does not inherit its line's font comes out ~46% oversized inside it.
  // Spelled out here rather than imported so the card stays a card — this
  // example must not drag the rail's module in to draw one anchor.
  $a.style.font = "inherit";
  return [$a];
}

// Every view model below is a FUNCTION, not a constant, and that is load
// bearing. `icon` and a `Node[]` sub hold real DOM nodes, and a node lives in
// exactly one place: the storybook binds `examples()[0]` twice — once as the
// card's preview, once in the expanded list — so a shared constant has its
// pip and its handle MOVED out of the first render into the second, and the
// preview silently loses them. Caught in the card, which is the only place
// the same view model is ever rendered twice.

/** The common case: marker, address, subject. Everything else on this list is
 *  that plus something. */
const PLAIN = (): RecordHeader.ViewModel => ({
  status: { icon: marker("var(--yellow)"), label: handle("L-184") },
  title: "docs(agent-sync): make generated snapshots reviewable as mirrors",
  // Empty, and that is the common case now: a record's address moved UP to
  // the status line, so most headers are a marker, a name and a subject. Subs
  // are for the extra facts only some records carry.
  subs: [],
  warn: null,
});

/** Several subs, mixing a link run with plain sentences — a mirrored draft
 *  that also carries a landed review record. */
const MULTI_SUB = (): RecordHeader.ViewModel => ({
  status: { icon: marker("var(--green)"), label: handle("L-207") },
  title: "feat(tento-spool): per-datatype renderers for harness-view",
  subs: [
    "mirrored from rwc-01 — a replayed copy of that host's draft; review it there",
    "review record: set-4471 (claude)",
  ],
  warn: null,
});

/** A record with something wrong about it. The warn line is the only part of
 *  the header that is allowed to be a sentence. */
const WARNED = (): RecordHeader.ViewModel => ({
  status: { icon: marker("var(--green)"), label: handle("L-193") },
  title: "fix(stack-log): stop the rail resetting scroll on every poll",
  subs: [],
  warn: "⚠ accepted but blocked by L-148, L-151",
});

/** No top line at all — the worktree pane's header. A worktree diff is not a
 *  record you can name or link to, so it has neither a state to mark nor an
 *  address to print, and the line is omitted rather than filled with a
 *  placeholder. Proves the row collapses instead of reserving a hole. */
const TITLE_ONLY = (): RecordHeader.ViewModel => ({
  // No state to report: a worktree diff has no verdict, and the line is
  // omitted rather than filled with a placeholder.
  status: null,
  title: "unstaged",
  subs: ["11 files · +342 −87 · worktree vs master tip"],
  warn: null,
});

/** A stand-in for the trailing slot: any control, right-aligned on the title
 *  row. The real one is std-revision-compare; this is a plain pill so the card
 *  stays about the header. */
function $trailingControl(): HTMLElement {
  const $btn = document.createElement("span");
  $btn.slot = "trailing";
  $btn.className = "text";
  $btn.textContent = "compare ▾";
  $btn.style.cssText = [
    "--font-size: var(--caption-size)",
    "padding: 3px 9px",
    "border: 1px solid var(--divider)",
    "border-radius: 6px",
    "color: var(--text-pri)",
  ].join(";");
  return $btn;
}

function withTrailing(vm: RecordHeader.ViewModel): HTMLElement {
  const $h = RecordHeader.makeWith(vm);
  $h.appendChild($trailingControl());
  return $h;
}

export class RecordHeaderStoryBook extends Storybook.Default {
  title(): string {
    return "RecordHeader (std-record-header)";
  }

  tags(): string[] {
    return ["std-record-header"];
  }

  description(): Option<string> {
    return (
      "The identity block of a single record opened in a detail pane: title, " +
      "the short facts that address it, an optional warning, a slot for a " +
      "control on the title row, and the rule closing the block off."
    );
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Marker + address + subject", render: () => Storybook.fill(RecordHeader.makeWith(PLAIN())) },
      { title: "Trailing control", render: () => Storybook.fill(withTrailing(PLAIN())) },
      { title: "Several sub lines", render: () => Storybook.fill(RecordHeader.makeWith(MULTI_SUB())) },
      { title: "Blocked (warn line)", render: () => Storybook.fill(RecordHeader.makeWith(WARNED())) },
      { title: "No address, no marker", render: () => Storybook.fill(RecordHeader.makeWith(TITLE_ONLY())) },
      {
        title: "Every state",
        render: () => Storybook.fill($states()),
      },
    ];
  }
}

/** Every state at once — the only example that is a COLUMN rather than a
 *  single header, because the point of it is the comparison between them.
 *  Still nothing but the component: five of it, stacked.
 *
 *  The labels are the VERDICT only — no `change ·` / `plan ·` prefix. What
 *  kind of record it is, the subject below already says. */
function $states(): HTMLElement {
  const $col = document.createElement("div");
  $col.style.cssText = "display: flex; flex-direction: column; gap: 18px; width: 100%";
  const rows: RecordHeader.Status[] = [
    { icon: marker("var(--yellow)"), label: handle("L-171") },
    { icon: marker("var(--green)"), label: handle("L-172") },
    { icon: marker("var(--red)"), label: handle("L-173") },
    { icon: null, label: "set-4471" },
  ];
  for (const status of rows) {
    $col.appendChild(
      RecordHeader.makeWith({
        status,
        title: "chore(absorb-stack): the sink verb stops at the first pending row",
        subs: [],
        warn: null,
      }),
    );
  }
  return $col;
}
