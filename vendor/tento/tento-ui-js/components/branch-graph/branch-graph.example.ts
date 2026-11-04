import { Storybook } from "../../ui/storybook";
import { BranchGraph } from "./branch-graph";
import { BranchLayout } from "./branch-graph-layout";

// Every card is the component at a width with nothing around it. The first
// three are the cases it was extracted for: a funnel with branches that end
// (the onboarding canvas's Preview), the same graph laid out trunk-first
// (`git log --graph`), and the stack log's two lanes written out by hand. The
// rest exercise one property each: merges and lane colour, the dense
// register, wrapping text, and selection.

const WIDTH = "360px";

function $graph(model: BranchGraph.Model, width = WIDTH): BranchGraph {
  const $g = BranchGraph.makeWith(model);
  $g.style.width = width;
  return $g;
}

type Kind = "stage" | "fork" | "step" | "win" | "partial" | "loss";
const MARK: Record<Kind, BranchGraph.Mark> = {
  stage: { shape: "circle", fill: "solid", tone: null },
  fork: { shape: "diamond", fill: "solid", tone: null },
  step: { shape: "circle", fill: "solid", tone: null },
  win: { shape: "square", fill: "solid", tone: "var(--green)" },
  partial: { shape: "square", fill: "solid", tone: "var(--yellow)" },
  loss: { shape: "square", fill: "solid", tone: "var(--red)" },
};

type Node = { id: string; title: string; kind: Kind; next: BranchLayout.DagNode["next"]; proposed?: boolean };

/** A paid funnel: a sign-in fork whose in-app branch ends in a waitlist,
 * an OAuth fork whose phone branch ends in a dead end, and the trunk to a
 * started trial. */
const FUNNEL: Node[] = [
  { id: "land", title: "Ad click lands on lona.so", kind: "stage", next: [{ to: "signin" }] },
  {
    id: "signin",
    title: "Sign in page",
    kind: "fork",
    next: [{ to: "oauth" }, { to: "email", label: "in-app webview" }],
  },
  { id: "email", title: "Leave your email", kind: "stage", next: [{ to: "lead" }] },
  { id: "lead", title: "Waitlist lead", kind: "partial", next: [] },
  {
    id: "oauth",
    title: "Google OAuth",
    kind: "fork",
    next: [{ to: "plan" }, { to: "notice", label: "phone" }],
  },
  { id: "notice", title: "Thanks for signing up", kind: "step", next: [{ to: "dead" }] },
  { id: "dead", title: "Mobile notice, no trial", kind: "loss", next: [] },
  { id: "plan", title: "Choose a plan", kind: "step", next: [{ to: "link" }], proposed: true },
  { id: "link", title: "Link accounts", kind: "step", next: [{ to: "first" }] },
  { id: "first", title: "First sheet", kind: "step", next: [{ to: "trial" }] },
  { id: "trial", title: "Trial started", kind: "win", next: [] },
];

/** The funnel with a walk through it: visited rows, walked edges, the
 * reader on "Link accounts". */
function funnel(order: BranchLayout.Order, opts: { walk?: string[]; density?: BranchGraph.Density } = {}): BranchGraph.Model {
  const walk = opts.walk ?? [];
  const byId = new Map(FUNNEL.map((n) => [n.id, n]));
  const walked = (from: string, to: string) => {
    const i = walk.indexOf(from);
    return i >= 0 && walk[i + 1] === to;
  };
  const dag = BranchGraph.fromDag(
    FUNNEL.map((n) => ({ id: n.id, next: n.next.map((e) => ({ ...e, walked: walked(n.id, e.to) })) })),
    { order },
  );
  return {
    density: opts.density,
    rows: dag.rows.map((r) => {
      const n = byId.get(r.id)!;
      return {
        ...BranchGraph.row(r.id, n.title, MARK[n.kind]),
        key: r.id,
        lane: r.lane,
        next: r.next,
        proposed: n.proposed === true,
        visited: walk.includes(r.id),
        current: walk[walk.length - 1] === r.id,
      };
    }),
  };
}

const WALK = ["land", "signin", "oauth", "plan", "link"];

/** The stack log's two lanes by hand: the working copy and a queued set on
 * dotted connectors above the drafts, the fork into the mainline at
 * origin/master, public diamonds below, and the dotted tail of history the
 * page does not load. */
function stackLog(): BranchGraph.Model {
  const r = BranchGraph.row;
  const draft = (tone: string): BranchGraph.Mark => ({ shape: "circle", fill: "solid", tone });
  const pub: BranchGraph.Mark = { shape: "diamond", fill: "solid", tone: null };
  return {
    rows: [
      { ...r("wc", "@ unstaged · 3 files", { shape: "circle", fill: "hollow", tone: null, dashed: true }), lane: 1, next: [{ to: "q1", style: "dotted" }] },
      { ...r("q1", "queued: chore(sdk): freeze the 2.0 surface", { shape: "square", fill: "hollow", tone: "var(--yellow)" }), lane: 1, next: [{ to: "d3", style: "dotted" }] },
      { ...r("d3", "feat(commit-review): project minitree", draft("var(--red)")), lane: 1, key: "d3", meta: "L-148", next: [{ to: "d2" }], current: true },
      { ...r("d2", "plan: two-audience commit messages", { shape: "triangle", fill: "hollow", tone: "var(--green)" }), lane: 1, key: "d2", meta: "L-147", next: [{ to: "d1" }] },
      { ...r("d1", "feat(review-notes): std-review-html", draft("var(--yellow)")), lane: 1, key: "d1", meta: "L-140", next: [{ to: "m1" }] },
      { ...r("m1", "feat(review): std-storybook-card tag", pub), lane: 0, key: "m1", meta: "D-6120", next: [{ to: "m2" }] },
      { ...r("m2", "feat(review-notes): review-flow, review-seq", pub), lane: 0, key: "m2", meta: "D-6098", next: [], exit: "dotted" },
    ],
  };
}

/** commit-review's rail in nodes mode, rebuilt from this component: the
 * working copy on a dotted connector, project containers (hollow yellow
 * hexagons, a pip per member, a chevron), the fork into the mainline, landed
 * diamonds with their handle line, a collapsed run and the history tail. */
function rail(): BranchGraph.Model {
  const r = BranchGraph.row;
  const y = "var(--yellow)";
  const pips = (spec: string): BranchGraph.Pip[] =>
    [...spec].map((c) => ({ tone: y, fill: c === "o" ? "hollow" : "solid" }));
  const project = (id: string, title: string, spec: string, next: string): BranchGraph.Row => ({
    ...r(id, title, { shape: "hexagon", fill: "hollow", tone: y }),
    key: id,
    lane: 1,
    pips: pips(spec),
    accessory: "chevron",
    next: [{ to: next }],
  });
  const landed = (id: string, title: string, handle: string, next: BranchGraph.Edge[]): BranchGraph.Row => ({
    ...r(id, title, { shape: "diamond", fill: "solid", tone: null }),
    key: id,
    muted: true,
    body: handle,
    next,
  });
  return {
    density: "rail",
    rows: [
      {
        ...r("wc", "unstaged", { shape: "circle", fill: "hollow", tone: null, dashed: true }),
        key: "wc",
        lane: 1,
        body: "75 files · +5835 −3460",
        next: [{ to: "p1", style: "dotted" }],
      },
      project("p1", "spaces.miniapp.automation", "•oo•", "p2"),
      project("p2", "artifacts-project-folders", "•oo•", "p3"),
      project("p3", "productionization", "o•oo•o•o•oo•o", "p4"),
      { ...project("p4", "artifacts-review-feed", "oo", "m1"), expanded: false },
      landed("m1", "Merge origin/master into the shared master", "D-177", [{ to: "m2" }]),
      landed("m2", "Record approved Artifacts 0.1.47 deployment", "D-176", [{ to: "run", style: "dotted" }]),
      { ...r("run", "⋯ 16 commits", null), kind: "run", key: "run", next: [{ to: "m3", style: "dotted" }] },
      landed("m3", "artifacts: record footer inset deployment", "D-159", [{ to: "m4" }]),
      landed("m4", "artifacts: inset review buttons within the card", "D-158", [{ to: "tail", style: "dotted" }]),
      { ...r("tail", "older history", null), kind: "tail" },
    ],
  };
}

/** A diamond with coloured lanes: three creatives rejoin one plan page. */
function creatives(): BranchGraph.Model {
  const dag = BranchGraph.fromDag([
    { id: "ad", next: [{ to: "cap" }, { to: "tz", label: "timezone creative" }, { to: "red", label: "redesign creative" }] },
    { id: "tz", next: [{ to: "plan" }] },
    { id: "red", next: [{ to: "plan" }] },
    { id: "cap", next: [{ to: "plan" }] },
    { id: "plan", next: [{ to: "signin" }] },
    { id: "signin", next: [] },
  ]);
  const titles: Record<string, string> = {
    ad: "Ad click lands on its creative's page",
    tz: "Your Tokyo meeting is not at 11pm",
    red: "Your calendar, beautifully redesigned",
    cap: "See what your week can actually hold",
    plan: "Pick a plan: 30 days free",
    signin: "Sign in page",
  };
  return {
    lanes: [{}, { color: "var(--blue)" }, { color: "var(--purple-fg)" }],
    rows: dag.rows.map((d) => ({
      ...BranchGraph.row(d.id, titles[d.id]!, { shape: d.id === "ad" ? "diamond" : "circle", fill: d.id === "ad" || d.id === "signin" ? "solid" : "hollow", tone: null }),
      lane: d.lane,
      next: d.next,
      proposed: d.id !== "ad" && d.id !== "signin",
    })),
  };
}

/** The project minitree's register: one lane, dense rows, trailing
 * handles, and an inert markless tail under a dashed rail. */
function minitree(): BranchGraph.Model {
  const r = BranchGraph.row;
  const draft = (tone: string, shape: BranchGraph.Shape = "circle", fill: BranchGraph.Fill = "solid"): BranchGraph.Mark => ({ shape, fill, tone });
  const landed: BranchGraph.Mark = { shape: "diamond", fill: "solid", tone: null };
  return {
    density: "dense",
    rows: [
      { ...r("a", "feat(commit-review): project minitree", draft("var(--red)")), key: "a", meta: "L-148", current: true, next: [{ to: "b" }] },
      { ...r("b", "plan: two-audience commit messages", draft("var(--green)", "triangle", "hollow")), key: "b", meta: "L-147", next: [{ to: "c" }] },
      { ...r("c", "feat(review-notes): std-review-html", draft("var(--green)")), key: "c", meta: "L-140", next: [{ to: "d" }] },
      { ...r("d", "feat(review): std-storybook-card tag", landed), muted: true, meta: "D-6120", next: [{ to: "e" }] },
      { ...r("e", "feat(review-notes): review-flow, review-seq", landed), muted: true, meta: "D-6098", next: [{ to: "older", style: "dashed" }] },
      { ...r("older", "⋯ 12 older", null), muted: true },
    ],
  };
}

function wrapping(): BranchGraph.Model {
  const r = BranchGraph.row;
  return {
    rows: [
      {
        ...r("a", "A title long enough to wrap onto a second line, which is where the mark's vertical alignment stops being a matter of opinion"),
        body: "And a body under it, indented clear of the graph, with the lane running down past it to the next row.",
        next: [{ to: "b" }, { to: "c" }],
      },
      { ...r("c", "A side branch with a body", { shape: "circle", fill: "hollow", tone: null }), lane: 1, body: "Hollow: the lane stops short of it.", next: [] },
      { ...r("b", "Back on the trunk"), next: [] },
    ],
  };
}

/** Clicking a row makes it current and walks the path to it. */
function $selectable(): BranchGraph {
  const $g = $graph(funnel("side-first", { walk: ["land"] }));
  const path: Record<string, string[]> = {};
  const parents = new Map<string, string>();
  for (const n of FUNNEL) for (const e of n.next) parents.set(e.to, n.id);
  for (const n of FUNNEL) {
    const p: string[] = [];
    for (let at: string | undefined = n.id; at != null; at = parents.get(at)) p.unshift(at);
    path[n.id] = p;
  }
  $g.onSelect = (key) => $g.bind(funnel("side-first", { walk: path[key] }));
  return $g;
}

export class BranchGraphStoryBook extends Storybook.Default {
  title(): string {
    return "Branch graph (std-branch-graph)";
  }

  examples(): Storybook.Example[] {
    return [
      { title: "commit-review's rail, nodes mode (density: rail)", render: () => $graph(rail(), "300px") },
      { title: "A funnel in the rail register", render: () => $graph(funnel("side-first", { walk: WALK, density: "rail" }), "300px") },
      { title: "A funnel, side branches first, mid-walk", render: () => $graph(funnel("side-first", { walk: WALK })) },
      { title: "The same graph trunk-first (git log --graph)", render: () => $graph(funnel("trunk-first", { walk: WALK })) },
      { title: "The stack log's two lanes, by hand", render: () => $graph(stackLog(), "420px") },
      { title: "Three branches rejoin, coloured lanes", render: () => $graph(creatives()) },
      { title: "Dense: the project minitree's register", render: () => $graph(minitree(), "380px") },
      { title: "Compact", render: () => $graph(funnel("side-first", { walk: WALK, density: "compact" }), "300px") },
      { title: "Wrapping titles and bodies", render: () => $graph(wrapping()) },
      { title: "Selectable: click a row to walk to it", render: () => $selectable() },
    ];
  }
}
