import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { join } from "jsr:@std/path";

import { BuildSwitchPlugin, parseBuildSwitch, switchModule, switchName } from "./build-switch.deno.ts";

const NAME = "EXAMPLE_NOTICE";
const SWITCHED = `// build-switch: ${NAME}\nconst notice: { text: string } | null = { text: "hosted-only copy" };\nexport default notice;\n`;

/** A site: `html/routes/index.root.ts` printing `html/routes/notice.switched.ts`'s default export. */
async function site(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "build-switch-" });
  const all: Record<string, string> = {
    "html/routes/notice.switched.ts": SWITCHED,
    "html/routes/index.root.ts": 'import notice from "./notice.switched.ts";\nglobalThis.out = notice;\n',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await Deno.mkdir(join(root, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, path), text);
  }
  return root;
}

let bundles = 0;

/** Bundles the site and evaluates it, returning what it exported as `out`. */
async function bundle(root: string): Promise<{ out: unknown; text: string }> {
  const routes = join(root, "html", "routes");
  const result = await esbuild.build({
    entryPoints: [join(routes, "index.root.ts")],
    bundle: true,
    write: false,
    format: "esm",
    minify: true,
    plugins: [new BuildSwitchPlugin(routes)],
    logLevel: "silent",
  });
  const text = result.outputFiles[0].text;
  const g = globalThis as { out?: unknown };
  delete g.out;
  // A unique suffix: an identical data: URL would return the cached module without running it.
  const run = `${text}\n// ${++bundles}\n`;
  await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(run)))}`);
  return { out: g.out, text };
}

Deno.test("switchName reads the header line and rejects a module without one", () => {
  assertEquals(switchName(SWITCHED, "m.switched.ts"), NAME);
  assertEquals(switchName(`// build-switch: A_1\r\nexport default 1;\n`, "m"), "A_1");
  assertThrows(() => switchName("export default 1;\n", "m.switched.ts"), Error, "m.switched.ts: a .switched.ts");
  assertThrows(() => switchName("// build-switch: not-a-name\n", "m"), Error, "build-switch: NAME");
});

Deno.test("parseBuildSwitch accepts on/off spellings and rejects anything else", () => {
  assert(parseBuildSwitch(NAME, " ON ", "x"));
  assert(parseBuildSwitch(NAME, "1", "x"));
  assert(!parseBuildSwitch(NAME, "false", "x"));
  assert(!parseBuildSwitch(NAME, "", "x"));
  assertThrows(() => parseBuildSwitch(NAME, "yes", "f.env"), Error, `f.env: ${NAME}="yes"`);
});

Deno.test("switch on bundles the module as written", async () => {
  const root = await site({ "html/.env": `${NAME}=on\n` });
  Deno.env.delete(NAME);
  const { out, text } = await bundle(root);
  assertEquals(out, { text: "hosted-only copy" });
  assert(text.includes("hosted-only copy"));
});

Deno.test("switch off or unset bundles null and none of the module's text", async () => {
  Deno.env.delete(NAME);
  for (const env of [`${NAME}=off\n`, "OTHER=on\n", null]) {
    const root = await site(env == null ? {} : { "html/.env": env });
    const { out, text } = await bundle(root);
    assertEquals(out, null, String(env));
    assert(!text.includes("hosted-only copy"), `copy bundled with .env ${env}`);
  }
});

Deno.test("the process environment overrides the .env switch", async () => {
  const root = await site({ "html/.env": `${NAME}=on\n` });
  const html = join(root, "html");
  const path = join(html, "routes", "notice.switched.ts");
  assertEquals((await switchModule(html, path, SWITCHED, () => "off")).on, false);
  assertEquals((await switchModule(html, path, SWITCHED, () => undefined)).on, true);
  await Deno.writeTextFile(join(html, ".env"), `${NAME}=off\n`);
  assertEquals((await switchModule(html, path, SWITCHED, () => "on")).on, true);
  const { watchFiles } = await switchModule(html, path, SWITCHED, () => undefined);
  assertEquals(watchFiles, [path, join(html, ".env")]);
});

Deno.test("a bad switch value or a missing header fails the build, naming the file", async () => {
  const root = await site({ "html/.env": `${NAME}=maybe\n` });
  const html = join(root, "html");
  await assertRejects(() => switchModule(html, "n.switched.ts", SWITCHED, () => undefined), Error, join(html, ".env"));
  const headless = () => switchModule(html, "n.switched.ts", "export default 1;\n", () => undefined);
  await assertRejects(headless, Error, "n.switched.ts");
});
