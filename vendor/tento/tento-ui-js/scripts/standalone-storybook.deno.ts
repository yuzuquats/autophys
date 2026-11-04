// Bundle a StoryBook class into a single standalone .html — every byte
// inlined (esbuild IIFE in an inline <script>), so the file works with no
// hosting and no network. Built for commit-queue artifacts: drop the output
// into `.commits/<id>.commit/artifacts/` and the review tool embeds it in a
// sandboxed iframe.
//
//   deno run -A tento/tento-ui-js/scripts/standalone-storybook.deno.ts \
//     --module @tento-ui/components/diff-view/diff-view.example \
//     --class DiffViewStoryBook \
//     --out /path/to/storybook.html
//
// The generated page calls only the storage-free core inits and shims
// localStorage/sessionStorage/document.cookie: an opaque-origin iframe
// (sandbox="allow-scripts") THROWS on real storage access, which would
// otherwise kill any bundle whose modules touch storage at import time
// (observed: the DarkMode module's localStorage.getItem at module scope).
import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

import { SvgLoaderPlugin } from "../../tento-web-js/build-plugins/svg-loader.deno.ts";

const HERE = new URL(".", import.meta.url).pathname;
// Borrowed for its @tento-ui/@tento-core path mappings + decorator settings.
const TSCONFIG = `${HERE}../../tento-node-registry/localhost.node/html/tsconfig.json`;

function arg(name: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  const value = i >= 0 ? Deno.args[i + 1] : undefined;
  if (!value) {
    console.error(
      "usage: standalone-storybook.deno.ts --module <import path> --class <StoryBook class> --out <out.html>",
    );
    Deno.exit(2);
  }
  return value;
}

const modulePath = arg("module");
const className = arg("class");
const out = arg("out");

const entry = `
import { initFastdom } from "@tento-ui/fastdom.global";
import { initDomUtils } from "@tento-ui/dom.global";
import { initHtmlElement } from "@tento-ui/init/html-element.global";

import { ${className} } from "${modulePath}";

initHtmlElement();
initFastdom();
initDomUtils();

async function main(): Promise<void> {
  const book = new ${className}();
  const $root = document.getElementById("root");
  if ($root == null) return;

  const $title = document.createElement("h1");
  $title.textContent = book.title();
  $root.appendChild($title);

  for (const example of book.examples()) {
    const $section = document.createElement("section");
    const $heading = document.createElement("h2");
    $heading.textContent = example.title ?? "";
    $section.appendChild($heading);
    const rendered = await example.render();
    const $content = rendered instanceof HTMLElement ? rendered : rendered.$content;
    $section.appendChild($content);
    $root.appendChild($section);
  }
}

void main();
`;

const entryDir = await Deno.makeTempDir({ prefix: "standalone-storybook" });
const entryPath = `${entryDir}/entry.ts`;
await Deno.writeTextFile(entryPath, entry);

const result = await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: "iife",
  platform: "browser",
  tsconfig: TSCONFIG,
  plugins: [new SvgLoaderPlugin()],
  loader: { ".png": "dataurl", ".woff2": "dataurl", ".woff": "dataurl" },
  write: false,
  minify: false,
  logLevel: "warning",
});
const js = new TextDecoder().decode(result.outputFiles[0].contents);
// A literal "</script>" inside the bundle would close our inline tag early.
const safe = js.replaceAll("</script", "<\\/script");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${className} — storybook (standalone)</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 24px; background: #10131a; color: #e8ebf2;
    font: 14px/1.5 -apple-system, system-ui, sans-serif;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h1::after {
    content: " · standalone artifact (all js inlined)";
    font-size: 12px; font-weight: 400; color: #8b93a7;
  }
  section { margin: 28px 0; }
  h2 { font-size: 13px; color: #8b93a7; font-weight: 600; margin: 0 0 10px; }
  section p { font-size: 12px; color: #8b93a7; margin: 0 0 10px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
// Sandbox armor: in an opaque-origin iframe (the review tool renders html
// artifacts with sandbox="allow-scripts"), localStorage/sessionStorage and
// document.cookie THROW on access. Shim them with inert in-memory stand-ins
// before the bundle runs, so storage-touching modules degrade gracefully.
(function () {
  function memoryStorage() {
    var m = new Map();
    return {
      get length() { return m.size; },
      key: function (i) { return Array.from(m.keys())[i] ?? null; },
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(String(k), String(v)); },
      removeItem: function (k) { m.delete(k); },
      clear: function () { m.clear(); },
    };
  }
  try { void window.localStorage; } catch (e) {
    Object.defineProperty(window, "localStorage", { value: memoryStorage() });
  }
  try { void window.sessionStorage; } catch (e) {
    Object.defineProperty(window, "sessionStorage", { value: memoryStorage() });
  }
  try { void document.cookie; } catch (e) {
    var jar = "";
    Object.defineProperty(Document.prototype, "cookie", {
      get: function () { return jar; },
      set: function (v) { jar = String(v).split(";")[0] + (jar ? "; " + jar : ""); },
    });
  }
})();
</script>
<script>
${safe}
</script>
</body>
</html>
`;
await Deno.writeTextFile(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KiB)`);
await Deno.remove(entryDir, { recursive: true });
await esbuild.stop();
