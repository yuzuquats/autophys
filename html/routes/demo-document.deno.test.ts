import { assertEquals, assert } from "jsr:@std/assert@1";
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
  assertEquals(view.main.body, { kind: "document", id: ids.overview(project), markdown: "# Battery overview" });
  assertEquals(view.details.title, "Overview");
  assertEquals(parseSel(raw.projects[0], ids.overview(project)), null);
  assert(view.sidebar.nodes[1].children!.every(node => node.label !== "Overview"));
});
