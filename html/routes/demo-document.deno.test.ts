import { assertEquals, assert, assertRejects } from "jsr:@std/assert@1";
import { investigationSummary } from "../client/derive/investigation-summary.ts";
import { withDemoDocument } from "./demo-document.ts";
import { fixtures } from "../client/fixtures/source.ts";
import { initialSelection, reduce } from "../client/controller.ts";
import { derive, ids, parseSel } from "../client/derive/index.ts";
import type { Source } from "../client/api.ts";
import type { Workspace } from "../client/domain.ts";

Deno.test("demo document survives refreshes and record folds without changing other projects", async () => {
  const snapshot = await fixtures([]).load();
  snapshot.workspace.projects[0].name = "battery_cycler_demo";
  const raw = snapshot.workspace;
  let push!: (workspace: Workspace) => void;
  const source: Source = { name: "test", load: async () => snapshot,
    post: async () => { throw Error("read only"); },
    fold: () => raw, stream: (_cursor, _record, workspace) => { push = workspace!; return () => {}; } };
  let reads = 0;
  const demo = withDemoDocument(source, async () => { reads++; return "# Battery overview"; });
  const decorated = await demo.load();
  const project = decorated.workspace.projects[0];
  assertEquals(project.overview, "# Battery overview");
  assertEquals(raw.projects[0].overview, undefined);
  assertEquals(decorated.workspace.projects[1], raw.projects[1]);
  assertEquals(demo.fold!(raw, {} as never)!.projects[0].overview, project.overview);
  let streamed: Workspace | undefined;
  demo.stream(0, () => {}, ws => { streamed = ws; });
  push(raw);
  assertEquals(streamed!.projects[0].overview, project.overview);
  await demo.load();
  assertEquals(reads, 1);
  const selection = reduce(initialSelection(decorated.workspace), decorated, { kind: "select", id: ids.overview(project) }, { user: "demo", now: () => "" }).selection;
  const view = derive(decorated, selection);
  assertEquals(view.sidebar.nodes[0].children![0].label, "Overview");
  assertEquals(view.main.body, { kind: "document", id: ids.overview(project), markdown: "# Battery overview", investigations: project.investigations.map(inv => investigationSummary(project, inv)) });
  assertEquals(view.details.title, "Overview");
  assertEquals(parseSel(raw.projects[0], ids.overview(project)), null);
  assert(view.sidebar.nodes[1].children!.every(node => node.label !== "Overview"));
});

Deno.test("each known demo gets its own cached Overview and retains it through updates", async () => {
  const snapshot = await fixtures([]).load(), base = snapshot.workspace.projects[0];
  const names = ["battery_cycler_demo", "mass_spring_damper_demo", "thermal_rc_demo", "jazz_performance_demo"];
  const paths = ["/demo-overview.md", "/demo-overview-oscillator.md", "/demo-overview-thermal.md", "/demo-overview-jazz.md"];
  snapshot.workspace.projects = names.map((name, n) => ({ ...base, name, id: `demo-${n}`,
    investigations: base.investigations.map(inv => ({ ...inv, id: `demo-${n}-${inv.id}`, projectId: `demo-${n}` })) }));
  const unrelated = { ...base, id: "other", name: "constructor", overview: "Existing document" };
  snapshot.workspace.projects.push(unrelated);
  let push!: (workspace: Workspace) => void;
  const raw = snapshot.workspace;
  const source: Source = { name: "test", load: async () => snapshot,
    post: async () => { throw Error("read only"); }, fold: () => raw,
    stream: (_cursor, _record, workspace) => { push = workspace!; return () => {}; } };
  const reads: string[] = [];
  const demo = withDemoDocument(source, async path => { reads.push(path); return `# Overview from ${path}`; });
  const loaded = await demo.load();
  assertEquals(reads, paths);
  const overviews = paths.map(path => `# Overview from ${path}`);
  assertEquals(loaded.workspace.projects.slice(0, names.length).map(p => p.overview), overviews);
  assert(raw.projects.slice(0, names.length).every(p => p.overview === undefined));
  assertEquals(loaded.workspace.projects[names.length], unrelated);
  for (const project of loaded.workspace.projects.slice(0, names.length)) {
    const selection = reduce(initialSelection(loaded.workspace), loaded, { kind: "select", id: ids.overview(project) }, { user: "demo", now: () => "" }).selection;
    const view = derive(loaded, selection);
    assertEquals(view.main.body.kind, "document");
    assert(view.sidebar.nodes.some(n => n.children?.some(child => child.id === ids.overview(project) && child.label === "Overview")));
  }
  assertEquals(demo.fold!(raw, {} as never)!.projects.slice(0, names.length).map(p => p.overview), overviews);
  let streamed: Workspace | undefined;
  demo.stream(0, () => {}, ws => { streamed = ws; }); push(raw);
  assertEquals(streamed!.projects.slice(0, names.length).map(p => p.overview), overviews);
  await demo.load(); assertEquals(reads, paths);
});

Deno.test("a failed overview fetch retries only that asset and skips unregistered projects", async () => {
  const snapshot = await fixtures([]).load(), base = snapshot.workspace.projects[0];
  snapshot.workspace.projects = [
    { ...base, name: "mass_spring_damper_demo" },
    { ...base, name: "thermal_rc_demo", id: "thermal" },
    { ...base, name: "unregistered", id: "other" },
  ];
  const source: Source = { name: "test", load: async () => snapshot,
    post: async () => { throw Error("read only"); }, stream: () => () => {} };
  const reads: string[] = [];
  let fail = true;
  const demo = withDemoDocument(source, async path => {
    reads.push(path);
    if (path.endsWith("thermal.md") && fail) { fail = false; throw Error("temporarily unavailable"); }
    return `# ${path}`;
  });
  await assertRejects(() => demo.load(), Error, "temporarily unavailable");
  const loaded = await demo.load();
  assertEquals(reads, ["/demo-overview-oscillator.md", "/demo-overview-thermal.md", "/demo-overview-thermal.md"]);
  assertEquals(loaded.workspace.projects[2].overview, undefined);
  assertEquals(loaded.workspace.projects[1].overview, "# /demo-overview-thermal.md");
});
