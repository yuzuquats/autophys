/// <reference lib="deno.ns" />
/**
 * The client's boundary, asserted: its files import only each other (relative, ending in
 * ".ts") and the ui's two type modules (view-model.ts, intent.ts) as `import type`, never a ui
 * component, the cookbook or a package. It touches no DOM, storage or network: data arrives
 * through api.ts's Source (whose daemon() is the only place /api/ may be named).
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("./", import.meta.url);
const UI_TYPES = ["view-model.ts", "intent.ts"];

async function walk(dir: URL, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) out.push(...await walk(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`));
    else if (e.name.endsWith(".ts")) out.push(`${prefix}${e.name}`);
  }
  return out.sort();
}
type Imp = { spec: string; typeOnly: boolean };
const imports = (src: string): Imp[] => [
  ...[...src.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g)].map((m) => ({ spec: m[3], typeOnly: !!m[2] })),
  ...[...src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)].map((m) => ({ spec: m[1], typeOnly: false })),
  ...[...src.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)/g)].map((m) => ({ spec: m[1], typeOnly: false })),
];

async function problems(read: (file: string) => Promise<string>): Promise<{ problems: string[]; seen: number }> {
  const files = await walk(ROOT), out: string[] = [];
  let seen = 0;
  for (const file of files) {
    const test = file.endsWith(".deno.test.ts");
    for (const { spec, typeOnly } of imports(await read(file))) {
      seen++;
      if (test && spec === "jsr:@std/assert@1") continue;
      if (!spec.startsWith(".")) { out.push(`${file}: ${spec}`); continue; }
      if (!spec.endsWith(".ts")) { out.push(`${file}: ${spec} (relative imports end in .ts)`); continue; }
      const target = new URL(spec, new URL(file, ROOT)).pathname;
      if (target.startsWith(ROOT.pathname)) { if (!files.includes(target.slice(ROOT.pathname.length))) out.push(`${file}: ${spec} (no such file)`); continue; }
      const ui = new URL("../ui/", ROOT).pathname;
      if (target.startsWith(ui) && UI_TYPES.includes(target.slice(ui.length)) && typeOnly) continue;
      out.push(`${file}: ${spec}${target.startsWith(ui) ? " (ui: import type of view-model.ts or intent.ts only)" : " (outside client)"}`);
    }
  }
  return { problems: out, seen };
}
const readReal = (file: string) => Deno.readTextFile(new URL(file, ROOT));

Deno.test("client boundary: own files, and the ui's view-model and intent types only", async () => {
  const { problems: p, seen } = await problems(readReal);
  assertEquals(p, []);
  assert(seen > 40, `only ${seen} imports seen`);
});

Deno.test("client boundary: a planted ui component, cookbook or package import fails it", async () => {
  for (const [file, line] of [
    ["controller.ts", `import { AutophysMain } from "../ui/main.ts";`],
    ["store.ts", `import { intentOf } from "../ui/intent.ts";`],
    ["derive/main.ts", `import { Cookbook } from "@tento-cookbook/lib.ts";`],
    ["derive/tree.ts", `import { Cookbook } from "../../routes/index.root.ts";`],
    ["api.ts", `import "npm:ky";`],
  ]) {
    const { problems: p } = await problems((f) => readReal(f).then((s) => (f === file ? `${line}\n${s}` : s)));
    assert(p.some((x) => x.startsWith(`${file}: `)), `${line} in ${file} was not caught`);
  }
});

Deno.test("client boundary: no DOM, storage or network outside api.ts", async () => {
  for (const file of await walk(ROOT)) {
    if (file.endsWith(".deno.test.ts")) continue;
    const src = await readReal(file);
    // api.ts is the one network module (the daemon source): fetch, EventSource and /api/ are its own.
    const network = ["fetch(", "EventSource", "/api/"];
    for (const banned of [...(file === "api.ts" ? [] : network), "XMLHttpRequest", "WebSocket", "localStorage", "indexedDB", "document.", "window.", "HTMLElement"]) {
      assert(!src.includes(banned), `${file} uses ${banned}`);
    }
  }
});
