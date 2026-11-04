import { assertEquals } from "jsr:@std/assert";
import { BranchLayout } from "./branch-graph-layout.ts";

type Row = BranchLayout.RowInput;
const row = (id: string, lane: number, next: BranchLayout.Edge[] = [], extra: Partial<Row> = {}): Row => ({
  id,
  lane,
  next,
  ...extra,
});
const to = (id: string, extra: Partial<BranchLayout.Edge> = {}): BranchLayout.Edge => ({ to: id, ...extra });
const solid = (lane: number, walked = false): BranchLayout.Line => ({ lane, style: "solid", walked });

/** "lane:id" per row, the shape a reader checks first. */
const lanes = (l: BranchLayout.DagLayout) => l.rows.map((r) => `${r.lane}:${r.id}`);
/** "from>to" per gap, curves only, "" for a gap with no strip. */
const curves = (l: BranchLayout.Layout) =>
  l.gaps.map((g) => g.links.filter((k) => k.from !== k.to).map((k) => `${k.from}>${k.to}`).join(","));

Deno.test("a single lane: straight segments, no strips, open at both ends", () => {
  const l = BranchLayout.route([row("a", 0, [to("b")]), row("b", 0, [to("c")]), row("c", 0)]);
  assertEquals(l.lanes, 1);
  assertEquals(l.gaps.map((g) => g.curved), [false, false]);
  assertEquals(l.rows[0].above, null);
  assertEquals(l.rows[0].below, solid(0));
  assertEquals(l.rows[1].above, solid(0));
  assertEquals(l.rows[2].below, null);
  assertEquals(l.rows.flatMap((r) => r.through), []);
  assertEquals(l.errors, []);
});

Deno.test("fromDag on a chain keeps one lane", () => {
  const dag = BranchLayout.fromDag([
    { id: "a", next: [{ to: "b" }] },
    { id: "b", next: [{ to: "c" }] },
    { id: "c", next: [] },
  ]);
  assertEquals(lanes(dag), ["0:a", "0:b", "0:c"]);
  assertEquals(curves(BranchLayout.route(dag.rows)), ["", ""]);
});

// The canvas's control arm in miniature: at sign in, some leave for a
// waitlist (a branch that terminates); the rest go on.
const FUNNEL: BranchLayout.DagNode[] = [
  { id: "land", next: [{ to: "signin" }] },
  { id: "signin", next: [{ to: "oauth" }, { to: "email", label: "in-app webview" }] },
  { id: "oauth", next: [{ to: "plan" }] },
  { id: "email", next: [{ to: "lead" }] },
  { id: "plan", next: [{ to: "trial" }] },
  { id: "trial", next: [] },
  { id: "lead", next: [] },
];

Deno.test("side-first: a terminating branch is drawn and closed under its fork", () => {
  const dag = BranchLayout.fromDag(FUNNEL);
  assertEquals(lanes(dag), ["0:land", "0:signin", "1:email", "1:lead", "0:oauth", "0:plan", "0:trial"]);
  const l = BranchLayout.route(dag.rows);
  assertEquals(l.lanes, 2);
  // The fork curve sits in the gap right under sign in, and is labelled.
  assertEquals(curves(l), ["", "0>1", "", "", "", ""]);
  assertEquals(l.gaps[1].labels, [{ lane: 1, text: "in-app webview" }]);
  assertEquals(l.gaps[1].opens, [1]);
  // The trunk passes the branch's rows; the branch ends at its terminal.
  assertEquals(l.rows[2].through, [solid(0)]);
  assertEquals(l.rows[3].through, [solid(0)]);
  assertEquals(l.rows[3].below, null);
  // After the terminal nothing is left on lane 1.
  assertEquals(l.rows[4].through, []);
  assertEquals(l.errors, []);
});

Deno.test("trunk-first: the branch lane runs beside the trunk until its rows come up", () => {
  const dag = BranchLayout.fromDag(FUNNEL, { order: "trunk-first" });
  assertEquals(lanes(dag), ["0:land", "0:signin", "0:oauth", "0:plan", "0:trial", "1:email", "1:lead"]);
  const l = BranchLayout.route(dag.rows);
  // Eager: the curve is under sign in even though email is four rows down.
  assertEquals(curves(l), ["", "0>1", "", "", "", ""]);
  assertEquals([2, 3, 4].map((r) => l.rows[r].through), [[solid(1)], [solid(1)], [solid(1)]]);
});

// A diamond: one fork, both sides rejoin.
const DIAMOND: BranchLayout.DagNode[] = [
  { id: "a", next: [{ to: "b" }, { to: "c" }] },
  { id: "b", next: [{ to: "d" }] },
  { id: "c", next: [{ to: "d" }] },
  { id: "d", next: [] },
];

Deno.test("merge: the side lane curves back into the trunk above the merge and frees", () => {
  const dag = BranchLayout.fromDag(DIAMOND);
  assertEquals(lanes(dag), ["0:a", "1:c", "0:b", "0:d"]);
  const l = BranchLayout.route(dag.rows);
  assertEquals(curves(l), ["0>1", "", "1>0"]);
  assertEquals(l.rows[2].through, [solid(1)]);
  assertEquals(l.rows[3].above, solid(0));
  assertEquals(l.lanes, 2);
});

Deno.test("merge, trunk-first: fork under the source, merge above the target", () => {
  const dag = BranchLayout.fromDag(DIAMOND, { order: "trunk-first" });
  assertEquals(lanes(dag), ["0:a", "0:b", "1:c", "0:d"]);
  assertEquals(curves(BranchLayout.route(dag.rows)), ["0>1", "", "1>0"]);
});

Deno.test("a freed lane is reused, lowest first", () => {
  // Two branches off the trunk, one after the other: the second takes lane 1
  // again once the first has terminated.
  const dag = BranchLayout.fromDag([
    { id: "a", next: [{ to: "b" }, { to: "x" }] },
    { id: "x", next: [] },
    { id: "b", next: [{ to: "c" }, { to: "y" }] },
    { id: "y", next: [] },
    { id: "c", next: [] },
  ]);
  assertEquals(lanes(dag), ["0:a", "1:x", "0:b", "1:y", "0:c"]);
  assertEquals(BranchLayout.route(dag.rows).lanes, 2);
});

Deno.test("lazy: a branch that starts late splits off the trunk right above its row", () => {
  // `a` forks twice; the first side branch is two rows long, so the second
  // leaves the trunk under it instead of holding a lane open from `a`.
  const dag = BranchLayout.fromDag([
    { id: "a", next: [{ to: "d" }, { to: "x" }, { to: "y" }] },
    { id: "x", next: [{ to: "x2" }] },
    { id: "x2", next: [] },
    { id: "y", next: [{ to: "d" }] },
    { id: "d", next: [] },
  ]);
  assertEquals(lanes(dag), ["0:a", "1:x", "1:x2", "1:y", "0:d"]);
  const l = BranchLayout.route(dag.rows);
  assertEquals(curves(l), ["0>1", "", "0>1", "1>0"]);
  assertEquals(l.lanes, 2);
});

Deno.test("a skip edge: the continuation steps aside and the skip keeps the lane", () => {
  const dag = BranchLayout.fromDag([
    { id: "a", next: [{ to: "b" }, { to: "c", style: "dashed" }] },
    { id: "b", next: [{ to: "c" }] },
    { id: "c", next: [] },
  ]);
  assertEquals(lanes(dag), ["0:a", "1:b", "0:c"]);
  const l = BranchLayout.route(dag.rows);
  assertEquals(curves(l), ["0>1", "1>0"]);
  assertEquals(l.rows[1].through, [{ lane: 0, style: "dashed", walked: false }]);
});

Deno.test("roots: a disconnected node gets the lowest free lane, after the tree", () => {
  const dag = BranchLayout.fromDag([
    { id: "a", next: [{ to: "b" }] },
    { id: "b", next: [] },
    { id: "lone", next: [] },
  ]);
  assertEquals(lanes(dag), ["0:a", "0:b", "0:lone"]);
  const l = BranchLayout.route(dag.rows);
  assertEquals(l.rows[2].above, null);
  assertEquals(l.rows[1].below, null);
});

Deno.test("the stack log's two lanes, written out by hand", () => {
  // Branch lane (1): working copy on a dotted connector, two drafts, then
  // the fork curve into the mainline (0) at origin/master, which carries on
  // past the loaded page as a dotted tail.
  const l = BranchLayout.route([
    row("unstaged", 1, [to("d2", { style: "dotted" })]),
    row("d2", 1, [to("d1")]),
    row("d1", 1, [to("m1")]),
    row("m1", 0, [to("m2")]),
    row("m2", 0, [], { exit: "dotted" }),
  ]);
  assertEquals(l.lanes, 2);
  assertEquals(curves(l), ["", "", "1>0", ""]);
  assertEquals(l.rows[0].below, { lane: 1, style: "dotted", walked: false });
  assertEquals(l.rows[1].above, { lane: 1, style: "dotted", walked: false });
  assertEquals(l.rows[4].below, { lane: 0, style: "dotted", walked: false });
  // Nothing on the mainline above origin/master.
  assertEquals(l.rows.slice(0, 3).flatMap((r) => r.through), []);
});

Deno.test("enter: a lane arriving from above the list runs from the top", () => {
  const l = BranchLayout.route([row("x", 1), row("m", 0, [], { enter: "solid" })]);
  assertEquals(l.rows[0].through, [solid(0)]);
  assertEquals(l.rows[1].above, solid(0));
  assertEquals(l.gaps[0].curved, false);
});

Deno.test("route infers via: fork when the target's lane is clear, merge when it is not", () => {
  const fork = BranchLayout.route([row("a", 0, [to("b"), to("c")]), row("b", 0, [to("d")]), row("c", 1), row("d", 0)]);
  assertEquals(curves(fork), ["0>1", "", ""]);
  const merge = BranchLayout.route([row("a", 0, [to("b")]), row("x", 1, [to("b")]), row("y", 1), row("b", 0)]);
  // x → b: lane 0 is clear between them? no — row y sits on lane 1, the
  // source's own lane; the target's lane 0 is clear, so it curves early.
  assertEquals(curves(merge), ["", "1>0", ""]);
});

Deno.test("walked edges win the shared stretch and are drawn last", () => {
  const l = BranchLayout.route([
    row("a", 0, [to("b", { walked: true }), to("c")]),
    row("b", 0, [to("c", { walked: true })]),
    row("c", 0),
  ]);
  assertEquals(l.rows[0].below, solid(0, true));
  assertEquals(l.rows[2].above, solid(0, true));
});

Deno.test("bad edges are reported and skipped, never thrown", () => {
  const l = BranchLayout.route([row("a", 0, [to("nope")]), row("b", 0, [to("a")])]);
  assertEquals(l.errors, ["a → nope: no such row", "b → a: points up the list"]);
  assertEquals(l.rows[0].below, null);
  const dag = BranchLayout.fromDag([
    { id: "a", next: [{ to: "b" }] },
    { id: "b", next: [{ to: "a" }] },
  ]);
  // Not a DAG: one edge of the cycle is dropped, every node still drawn.
  assertEquals(dag.errors.length, 1);
  assertEquals(dag.errors[0].endsWith("closes a cycle; not drawn"), true);
  assertEquals(lanes(dag).length, 2);
});

Deno.test("given order keeps the caller's rows", () => {
  const dag = BranchLayout.fromDag(DIAMOND, { order: "given" });
  assertEquals(lanes(dag), ["0:a", "0:b", "1:c", "0:d"]);
});

Deno.test("side-first: a branch that ends comes before one that rejoins, so the rejoining lane closes into its merge", () => {
  // The canvas's arm A in miniature: an in-app check forks to the trunk
  // (sign in), an escape that rejoins sign in, and an email branch that
  // ends in a lead. Listed escape-first, drawn email-first.
  const dag = BranchLayout.fromDag([
    { id: "check", next: [{ to: "signin" }, { to: "escape" }, { to: "email" }] },
    { id: "escape", next: [{ to: "signin" }] },
    { id: "email", next: [{ to: "lead" }] },
    { id: "lead", next: [] },
    { id: "signin", next: [] },
  ]);
  assertEquals(lanes(dag), ["0:check", "1:email", "1:lead", "1:escape", "0:signin"]);
  const l = BranchLayout.route(dag.rows);
  assertEquals(l.lanes, 2);
  assertEquals(curves(l), ["0>1", "", "0>1", "1>0"]);
});
