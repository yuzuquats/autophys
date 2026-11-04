/// <reference lib="deno.ns" />
/**
 * The layering of html/: ui/ and client/ each have their own boundary test; this one checks
 * that routes/ (the composition root) is the only place they meet the cookbook, and that
 * nothing else holds code at the top.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("./", import.meta.url);

Deno.test("layers: only ui/, client/ and routes/ hold code; only routes/ imports the cookbook", async () => {
  const top: string[] = [];
  for await (const e of Deno.readDir(ROOT)) top.push(e.isDirectory ? `${e.name}/` : e.name);
  assertEquals(top.filter((n) => n.endsWith(".ts")).sort(), ["boundary.deno.test.ts"]);
  assertEquals(top.filter((n) => n.endsWith("/")).sort(), ["client/", "routes/", "ui/"]);
  const root = await Deno.readTextFile(new URL("routes/index.root.ts", ROOT));
  for (const spec of ["@tento-cookbook/lib.ts", "../client/store.ts", "../client/controller.ts", "../ui/sidebar.ts"]) assert(root.includes(`"${spec}"`), `the root imports ${spec}`);
  for (const dir of ["ui/", "client/"]) {
    for await (const e of Deno.readDir(new URL(dir, ROOT))) {
      if (!e.isFile || !e.name.endsWith(".ts") || e.name.endsWith(".deno.test.ts")) continue;
      assert(!(await Deno.readTextFile(new URL(`${dir}${e.name}`, ROOT))).includes("tento-cookbook"), `${dir}${e.name} names the cookbook`);
    }
  }
});
