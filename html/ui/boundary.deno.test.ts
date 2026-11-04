/// <reference lib="deno.ns" />
/**
 * The package's dependency set, asserted: its files import only each other (relative, ending
 * in ".ts"), the tento-ui tree list, and (tests only) the std assertions. It makes no network
 * call and touches no storage: the components are view-only.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("./", import.meta.url);
const ALLOWED = ["@tento-ui/components/tree-list/tree-list", "@tento-ui/components/empty-state/empty-state",
  "@tento-ui/components/skeleton/skeleton", "@tento-ui/components/input/select-input", "@tento-ui/components/button/button", "@tento-ui/ui/icons"];

async function sources(): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const e of Deno.readDir(ROOT)) if (e.isFile && e.name.endsWith(".ts")) out.push([e.name, await Deno.readTextFile(new URL(e.name, ROOT))]);
  return out.sort();
}
const specs = (src: string) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`]+)/g)]
  .map((m) => m[1] ?? m[2] ?? m[3]);

Deno.test("boundary: own files, the tree list, and std assertions in tests only", async () => {
  const files = await sources();
  const names = files.map(([n]) => n);
  const problems: string[] = [];
  let seen = 0;
  for (const [name, src] of files) {
    for (const spec of specs(src)) {
      seen++;
      if (spec.startsWith("./")) {
        if (!spec.endsWith(".ts") || !names.includes(spec.slice(2))) problems.push(`${name}: ${spec}`);
      } else if (ALLOWED.includes(spec) && !name.endsWith(".deno.test.ts")) continue;
      else if (spec === "jsr:@std/assert@1" && name.endsWith(".deno.test.ts")) continue;
      else problems.push(`${name}: ${spec}`);
    }
  }
  assertEquals(problems, []);
  assert(seen > 20, `only ${seen} imports seen`);
});

Deno.test("boundary: no network or storage; presentation callbacks stay isolated", async () => {
  for (const [name, src] of await sources()) {
    if (name.endsWith(".deno.test.ts")) continue;
    // The presentation timeline advances derived text only; it clears its callback on detach.
    for (const banned of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage", "indexedDB", "setInterval(", "setTimeout(", "WebSocket"]) {
      if (name === "timeline.ts" && banned === "setTimeout(") continue;
      assert(!src.includes(banned), `${name} uses ${banned}`);
    }
  }
});
