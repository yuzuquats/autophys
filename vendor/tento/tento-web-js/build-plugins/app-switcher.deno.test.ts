import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert";
import { join } from "jsr:@std/path";

import { AppSwitcherPlugin, packageAppSwitcher, parseEnvFile, parseManifest, parseSwitch } from "./app-switcher.deno.ts";
import { SvgLoaderPlugin } from "./svg-loader.deno.ts";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>';

/** A site: `html/routes/index.root.ts` printing the packaged switcher, and `html/kit/app-switcher.packaged.ts`. */
async function site(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "app-switcher-" });
  const all: Record<string, string> = {
    "html/kit/app-switcher.packaged.ts": "export const PACKAGED_APP_SWITCHER = undefined;\n",
    "html/routes/index.root.ts":
      'import { PACKAGED_APP_SWITCHER } from "../kit/app-switcher.packaged.ts";\nglobalThis.out = PACKAGED_APP_SWITCHER;\n',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await Deno.mkdir(join(root, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, path), text);
  }
  return root;
}

const MANIFEST = JSON.stringify({
  label: "Switch Lona app",
  apps: [
    { id: "calendar", name: "Calendar", href: "https://dev.lona.so", icon: "app-switcher/calendar.svg" },
    { id: "autophys", name: "Autophys", href: "https://autophys.lona.so", icon: "app-switcher/autophys.svg" },
  ],
});

/** Bundles the site and evaluates it, returning what it exported as `out`. */
async function bundle(root: string): Promise<{ out: unknown; text: string }> {
  const routes = join(root, "html", "routes");
  const result = await esbuild.build({
    entryPoints: [join(routes, "index.root.ts")],
    bundle: true,
    write: false,
    format: "esm",
    plugins: [new SvgLoaderPlugin(), new AppSwitcherPlugin(routes)],
    logLevel: "silent",
  });
  const text = result.outputFiles[0].text;
  const g = globalThis as { out?: unknown };
  delete g.out;
  await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(text)))}`);
  return { out: g.out, text };
}

Deno.test("parseSwitch accepts on/off spellings and rejects anything else", () => {
  assert(parseSwitch("on", "x"));
  assert(parseSwitch(" TRUE ", "x"));
  assert(!parseSwitch("off", "x"));
  assert(!parseSwitch("0", "x"));
  assertThrows(() => parseSwitch("lona", "f.env"), Error, "expected on or off");
});

Deno.test("parseEnvFile reads KEY=value with comments, export and quotes", () => {
  assertEquals(parseEnvFile("# c\n\nexport A=1\nB = 'two'\nC=\"3\"\n", "f"), { A: "1", B: "two", C: "3" });
  assertThrows(() => parseEnvFile("nope\n", "f.env"), Error, "f.env:1");
});

Deno.test("parseManifest rejects duplicate ids, unsafe links, non-svg icons and unknown keys", () => {
  const app = { id: "a", name: "A", href: "https://a.example", icon: "a.svg" };
  assertEquals(parseManifest(JSON.stringify({ apps: [app] }), "m").apps, [app]);
  assertThrows(() => parseManifest(JSON.stringify({ apps: [app, app] }), "m"), Error, "duplicate id");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [{ ...app, href: "javascript:alert(1)" }] }), "m"), Error, "http(s)");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [{ ...app, icon: "a.png" }] }), "m"), Error, ".svg");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [{ ...app, icon: "a.SVG" }] }), "m"), Error, ".svg");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [{ ...app, color: "red" }] }), "m"), Error, "unknown key");
  assertThrows(() => parseManifest("{", "m.json"), Error, "m.json: not JSON");
});

Deno.test("no manifest leaves the on-disk module", async () => {
  const root = await site({});
  assertEquals(await packageAppSwitcher(join(root, "html"), "on"), null);
  assertEquals((await bundle(root)).out, undefined);
});

Deno.test("switch on bundles the manifest's apps with their icons", async () => {
  const root = await site({
    "html/app-switcher.json": MANIFEST,
    "html/.env": "TENTO_APP_SWITCHER=on\n",
    "html/app-switcher/calendar.svg": ICON,
    "html/app-switcher/autophys.svg": ICON.replace("rect", "circle"),
  });
  Deno.env.delete("TENTO_APP_SWITCHER");
  const { out } = await bundle(root);
  const packaged = out as { label: string; apps: { id: string; href: string; icon: string }[] };
  assertEquals(packaged.label, "Switch Lona app");
  assertEquals(packaged.apps.map((a) => a.id), ["calendar", "autophys"]);
  assertEquals(packaged.apps[0].icon, ICON);
  assertStringIncludes(packaged.apps[1].icon, "<circle");
  assert(Object.isFrozen(packaged.apps));
});

Deno.test("switch off bundles no link or icon", async () => {
  const root = await site({
    "html/app-switcher.json": MANIFEST,
    "html/.env": "TENTO_APP_SWITCHER=off\n",
    "html/app-switcher/calendar.svg": ICON,
    "html/app-switcher/autophys.svg": ICON,
  });
  Deno.env.delete("TENTO_APP_SWITCHER");
  const { out, text } = await bundle(root);
  assertEquals(out, null);
  assert(!text.includes("lona.so"), "a link was bundled");
  assert(!text.includes("<svg"), "an icon was bundled");
});

Deno.test("the process environment overrides the .env switch; absent both, it is off", async () => {
  const root = await site({
    "html/app-switcher.json": MANIFEST,
    "html/.env": "TENTO_APP_SWITCHER=on\n",
    "html/app-switcher/calendar.svg": ICON,
    "html/app-switcher/autophys.svg": ICON,
  });
  const html = join(root, "html");
  assertStringIncludes((await packageAppSwitcher(html, "off"))!.contents, "= null");
  await Deno.remove(join(html, ".env"));
  assertStringIncludes((await packageAppSwitcher(html, undefined))!.contents, "= null");
  assertStringIncludes((await packageAppSwitcher(html, "on"))!.contents, "icon0");
});

Deno.test("a missing or escaping icon fails the build, naming the manifest", async () => {
  const root = await site({ "html/app-switcher.json": MANIFEST, "html/app-switcher/calendar.svg": ICON });
  const html = join(root, "html");
  await assertRejects(() => packageAppSwitcher(html, "on"), Error, "autophys");
  await Deno.writeTextFile(
    join(html, "app-switcher.json"),
    JSON.stringify({ apps: [{ id: "x", name: "X", href: "https://x.example", icon: "../../etc/x.svg" }] }),
  );
  await assertRejects(() => packageAppSwitcher(html, "on"), Error, "outside");
  // A symlink inside the site that points outside it is outside too.
  const elsewhere = await Deno.makeTempFile({ suffix: ".svg" });
  await Deno.writeTextFile(elsewhere, ICON);
  await Deno.symlink(elsewhere, join(html, "app-switcher", "link.svg"));
  await Deno.writeTextFile(
    join(html, "app-switcher.json"),
    JSON.stringify({ apps: [{ id: "x", name: "X", href: "https://x.example", icon: "app-switcher/link.svg" }] }),
  );
  await assertRejects(() => packageAppSwitcher(html, "on"), Error, "outside");
  // A name that merely starts with two dots is inside.
  await Deno.writeTextFile(join(html, "..dots.svg"), ICON);
  await Deno.writeTextFile(
    join(html, "app-switcher.json"),
    JSON.stringify({ apps: [{ id: "x", name: "X", href: "https://x.example", icon: "..dots.svg" }] }),
  );
  assertStringIncludes((await packageAppSwitcher(html, "on"))!.contents, "icon0");
});

Deno.test("parseManifest accepts inline svg icons, a footer and per-variant tokens", () => {
  const svg = { id: "a", name: "A", href: "https://a.example", svg: ICON };
  const footer = { href: "https://studio.example/", label: "Studio", detail: "studio.example" };
  const tokens = { light: { sheet: "#fff", "cell-radius": "10px" }, dark: { sheet: "#20231f" } };
  assertEquals(parseManifest(JSON.stringify({ apps: [svg], footer, tokens }), "m"), { apps: [svg], footer, tokens });
  assertEquals(parseManifest(JSON.stringify({ apps: [], footer: { href: "https://x.example", label: "X" } }), "m").footer, {
    href: "https://x.example",
    label: "X",
  });
  const both = { ...svg, icon: "a.svg" };
  assertThrows(() => parseManifest(JSON.stringify({ apps: [both] }), "m"), Error, "exactly one of icon and svg");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [{ id: "a", name: "A", href: "https://a.example" }] }), "m"), Error, "exactly one");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [{ ...svg, svg: "<img>" }] }), "m"), Error, "<svg>");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [], footer: { ...footer, href: "javascript:x" } }), "m"), Error, "footer: href");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [], footer: { ...footer, extra: 1 } }), "m"), Error, "footer: unknown key");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [], tokens: { sepia: {} } }), "m"), Error, "tokens: unknown key");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [], tokens: { light: { Sheet: "#fff" } } }), "m"), Error, "token name");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [], tokens: { light: { sheet: "red; x: y" } } }), "m"), Error, "must not contain");
  assertThrows(() => parseManifest(JSON.stringify({ apps: [], tokens: { dark: { sheet: 1 } } }), "m"), Error, "non-empty string");
});

Deno.test("a self-contained manifest bundles inline svg icons, its footer and tokens; file icons still work beside them", async () => {
  const root = await site({
    "html/app-switcher.json": JSON.stringify({
      $comment: "generated",
      label: "Switch Lona app",
      apps: [
        { id: "calendar", name: "Calendar", href: "https://dev.lona.so", svg: ICON },
        { id: "autophys", name: "Autophys", href: "https://autophys.lona.so", icon: "app-switcher/autophys.svg" },
      ],
      footer: { href: "https://studio.lona.so/", label: "Product design and engineering", detail: "studio.lona.so" },
      tokens: { light: { sheet: "#fff", muted: "#6a6e66" }, dark: { sheet: "#20231f" } },
    }),
    "html/.env": "TENTO_APP_SWITCHER=on\n",
    "html/app-switcher/autophys.svg": ICON.replace("rect", "circle"),
  });
  Deno.env.delete("TENTO_APP_SWITCHER");
  const { out } = await bundle(root);
  const packaged = out as {
    apps: { id: string; icon: string }[];
    footer: Record<string, string>;
    tokens: { light: Record<string, string>; dark: Record<string, string> };
  };
  assertEquals(packaged.apps.map((a) => a.icon), [ICON, ICON.replace("rect", "circle")]);
  assertEquals(packaged.footer, {
    href: "https://studio.lona.so/",
    label: "Product design and engineering",
    detail: "studio.lona.so",
  });
  assertEquals(packaged.tokens, { light: { sheet: "#fff", muted: "#6a6e66" }, dark: { sheet: "#20231f" } });
  assert(Object.isFrozen(packaged.footer) && Object.isFrozen(packaged.tokens) && Object.isFrozen(packaged.tokens.light));
});

Deno.test("a manifest without footer or tokens packages them as null", async () => {
  const root = await site({
    "html/app-switcher.json": MANIFEST,
    "html/app-switcher/calendar.svg": ICON,
    "html/app-switcher/autophys.svg": ICON,
  });
  const { contents } = (await packageAppSwitcher(join(root, "html"), "on"))!;
  assertStringIncludes(contents, "footer: null,");
  assertStringIncludes(contents, "tokens: null,");
});

Deno.test("switch off bundles no footer or token from a self-contained manifest", async () => {
  const root = await site({
    "html/app-switcher.json": JSON.stringify({
      apps: [{ id: "a", name: "A", href: "https://a.example", svg: ICON }],
      footer: { href: "https://studio.lona.so/", label: "Studio" },
      tokens: { light: { sheet: "#123456" } },
    }),
  });
  const { contents } = (await packageAppSwitcher(join(root, "html"), "off"))!;
  for (const leak of ["studio.lona.so", "#123456", "<svg"]) assert(!contents.includes(leak), `${leak} was bundled`);
});

Deno.test({
  name: "stop esbuild",
  fn: async () => {
    await esbuild.stop();
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
