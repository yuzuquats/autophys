// Per-file ("unbundled") emit pipeline.
//
// Companion to bundler.deno.ts. Where the bundle build inlines a route's whole
// import graph into one `*.root.js`, this emits one JS file per source module,
// content-addressed, with every import rewritten to a stable logical id that an
// import map resolves to the hashed URL. See
// lona/lona-console/projects/fe-import-maps-dcz.project.docs/content/README.md
//
// Output (under `<outRoot>/js/m/...`), an import-map.json + preload manifest per
// route root. Module bodies contain NO hashes (the hash lives only in the import
// map) — this is what keeps an edit from cascading new hashes up the graph.

import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";
import { ensureDir, expandGlob } from "jsr:@std/fs";
import { basename, dirname, join, relative, resolve } from "jsr:@std/path";
import { SvgLoaderPlugin } from "../../../tento-web-js/build-plugins/svg-loader.deno.ts";
import { frontendTsconfig } from "./frontend-tsconfig.deno.ts";
import { type ResolutionEvidence, resolutionEvidence } from "./bundler-resolution.deno.ts";

// Module-id root, derived from this file's REAL location: the app root that
// holds both its html/ and vendor/tento/tento-web/src/client (up 5). Real, not
// as invoked: on a host that overlays `mono/tento` as a
// symlink to the sibling checkout, esbuild hands back resolved (real) paths
// under `workspace/tento/…`, and a root computed from the symlinked spelling
// (`workspace/mono`) is not an ancestor of them — every shared module then
// gets an id starting with `../`, and the emit fails on the first one it
// tries to read back. Resolving the symlink first puts the root where the
// files actually are, for both layouts.
const REPO_ROOT = resolve(
  Deno.realPathSync(new URL(".", import.meta.url).pathname),
  "../../../../..",
);

const SOURCE_EXT = /\.(tsx?|jsx?|mjs)$/;

// Barrel deep-resolution is intentionally NOT done here. We measured it on the
// calendar route and it is net-negative:
//   * Calendar genuinely uses ~every leaf its package-root barrels re-export, so
//     deep-resolving culls only the ~5 tiny barrel-shell fetches (the leaves are
//     fetched either way) — no meaningful cold-load win.
//   * Inlining a barrel that uses `export *` / `export * as NS` / inline locals
//     (`@tento-lona/sheets`, `@tento-chrono`) forces esbuild to bundle the
//     star-sources into every importer (+2.5MB duplicated across ~80 files),
//     because you cannot `export *` from an external module inside a merged one.
//   * The same `export *` makes externalizing one barrel while inlining a
//     dependent barrel fail to resolve (build error).
// So by default every barrel is externalized like any other module. A
// duplication-free per-export rewrite is future work, worthwhile only for
// genuinely light routes (marketing/landing) that touch a small fraction of a
// package — not calendar.
//
// Measurement knob: LONA_INLINE_BARRELS=<comma-separated repo-rel paths> inlines
// (deep-resolves through) the listed barrels, for A/B sizing the culling on light
// routes. Unset/empty = naive (the measured-best for heavy routes). Inlining a
// barrel that uses `export *` duplicates its star-sources into importers, so this
// knob over-counts bytes but the closure *file count* it yields is the true
// culling potential.
const INLINE_BARREL_PATHS = new Set(
  (Deno.env.get("LONA_INLINE_BARRELS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rel) => resolve(REPO_ROOT, rel)),
);

// TENTO_PERFILE_TIMINGS=1 prints each phase's duration to stderr.
const TIMINGS = Deno.env.get("TENTO_PERFILE_TIMINGS") === "1";
function phase(label: string, since: number): number {
  const now = performance.now();
  if (TIMINGS) console.error(`perfile timing ${label}: ${(now - since).toFixed(0)} ms`);
  return now;
}

function isInlineBarrel(absPath: string): boolean {
  return INLINE_BARREL_PATHS.has(absPath);
}

// Matches the specifier in a (minified) static import/re-export/side-effect
// import: `from"@m/x"`, `from "@m/x"`, `export*from"@m/x"`, `import"@m/x"`.
const IMPORT_SPEC_RE = /(?:from|import)\s*["']([^"']+)["']/g;

export type PerFileResult = {
  // logical id -> hashed URL, e.g. "@m/tento/tento-ui-js/cookies" -> "/js/m/.../cookies.7e3d.js"
  importMap: Record<string, string>;
  // one entry per `*.root.ts`, keyed by its logical id
  roots: Array<{
    rootLogicalId: string;
    entryUrl: string; // hashed URL of the root module
    preload: string[]; // hashed URLs of every module in this root's static graph
    // Route-relative bundled HTML that boots this root, e.g. "index.anon.html".
    // DISCOVERED, not derived from the root's filename — see `findEntryHtml`.
    htmlRel: string;
    // The bundle script this root emits, e.g. "index.root.js". Derived from the
    // ROOT's name (the only authoritative source) and the thing the entry HTML
    // is matched on; it is NOT `htmlRel` with the extension swapped, because
    // `index.root.ts` boots from `index.anon.html` in every loopback miniapp.
    scriptBase: string;
  }>;
  // Every file pass 1 read (absolute; vendor included, plugin namespaces
  // excluded). The bundler's reuse stamp hashes these.
  inputs: string[];
  // Where pass 1's resolver looked (bundler-resolution.deno.ts), for the stamp.
  resolution: ResolutionEvidence;
};

function repoRel(absPath: string): string {
  return relative(REPO_ROOT, absPath);
}

function stripExt(p: string): string {
  return p.replace(SOURCE_EXT, "");
}

// First-party module → stable, hash-free logical id (the import-map key).
function logicalIdFor(absPath: string): string {
  return "@m/" + stripExt(repoRel(absPath));
}

function isVendor(absPath: string): boolean {
  return absPath.includes("/node_modules/");
}

// Plugin: resolve every import via esbuild's real pipeline (tsconfig paths,
// node_modules), then mark it external with a logical-id specifier so nothing is
// inlined and the emitted body carries a stable, hash-free reference.
function externalizeAndRewrite(): esbuild.Plugin {
  return {
    name: "externalize-and-rewrite",
    setup(build: esbuild.PluginBuild) {
      build.onResolve({ filter: /.*/ }, async (args: esbuild.OnResolveArgs) => {
        // Entry points must be emitted, not externalized.
        if (args.kind === "entry-point") return null;
        // Re-entrant call from our own build.resolve below: defer to esbuild.
        // deno-lint-ignore no-explicit-any
        if ((args.pluginData as any)?.__perfile) return null;

        const r = await build.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { __perfile: true },
        });
        if (r.errors.length > 0) return { errors: r.errors };
        // Already external (e.g. an http: URL) — leave the specifier as-is.
        if (r.external) return { path: r.path, external: true };
        // Inline anything that isn't a first-party source module: svg → text,
        // css, json, and other assets are bundled into the importer as today.
        if (!SOURCE_EXT.test(r.path)) return null;

        if (isVendor(r.path)) {
          // Phase 1: vendor is not expected in calendar's static graph (it is
          // lazy-loaded). Surface it loudly rather than silently mishandling.
          throw new Error(
            `perfile: vendor module in static graph (not yet handled): ${repoRel(r.path)} (imported by ${args.importer})`,
          );
        }
        // Opt-in deep-resolution (LONA_INLINE_BARRELS): return null so esbuild
        // bundles through the barrel and rewrites imports to the leaf modules.
        if (isInlineBarrel(r.path)) return null;
        return { path: logicalIdFor(r.path), external: true };
      });
    },
  };
}

async function sha8(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 8);
}

/**
 * Emit a route directory's modules one-file-per-module, content-hashed, and
 * return the import map + per-root preload manifests.
 */
export async function buildPerFile({
  routesPath,
  outRoot,
}: {
  routesPath: string;
  outRoot: string;
}): Promise<PerFileResult> {
  const roots = (await Array.fromAsync(expandGlob(`${routesPath}/**/*.root.ts`)))
    .map((p) => p.path)
    .sort();
  if (roots.length === 0) {
    const resolution = resolutionEvidence({ inputs: {} }, REPO_ROOT, undefined);
    return { importMap: {}, roots: [], inputs: [], resolution };
  }

  let t = performance.now();
  // Pass 1 — graph discovery. A normal bundle with metafile resolves the full
  // first-party module graph (and per-root reachable sets) without writing.
  const graph = await esbuild.build({
    ...frontendTsconfig(routesPath),
    entryPoints: roots,
    absWorkingDir: REPO_ROOT,
    outdir: "js/m",
    outbase: REPO_ROOT,
    bundle: true,
    metafile: true,
    write: false,
    treeShaking: true,
    format: "esm",
    logLevel: "silent",
    plugins: [new SvgLoaderPlugin()],
  });

  // All first-party source modules reachable from any root.
  const inputAbs = (rel: string) => resolve(REPO_ROOT, rel);
  const inputs = Object.keys(graph.metafile!.inputs)
    .filter((rel) => !/^[a-z-]+:/.test(rel))
    .map(inputAbs)
    .sort();
  const moduleSet = new Set<string>();
  for (const inputRel of Object.keys(graph.metafile!.inputs)) {
    const abs = inputAbs(inputRel);
    if (isVendor(abs)) continue;
    if (!SOURCE_EXT.test(abs)) continue; // skip svg/css inputs (inlined)
    if (isInlineBarrel(abs)) continue; // inlined into importers, not emitted
    moduleSet.add(abs);
  }
  const modules = [...moduleSet].sort();
  t = phase(`pass 1 graph (${modules.length} modules)`, t);
  const resolution = resolutionEvidence(
    graph.metafile,
    REPO_ROOT,
    frontendTsconfig(routesPath).tsconfig,
  );
  t = phase(`pass 1 resolution replay (${resolution.edges} edges)`, t);

  // Pass 2 writes into a staging dir private to this emit, and a module only
  // enters the shared store under its content-hashed name. Emitting the
  // unhashed `x.js` straight into the store let two emits into one store (two
  // domains) rename or append to each other's file before it was hashed; with
  // hashed names a concurrent writer writes either the same bytes or another
  // name. The staging dir sits outside `js/`, so nothing serves it.
  const staging = join(outRoot, ".perfile-staging", crypto.randomUUID());
  try {
    return {
      ...(await emitStaged({ routesPath, outRoot, staging, roots, modules, inputs, t })),
      resolution,
    };
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}

async function emitStaged({
  routesPath,
  outRoot,
  staging,
  roots,
  modules,
  inputs,
  t,
}: {
  routesPath: string;
  outRoot: string;
  staging: string;
  roots: string[];
  modules: string[];
  inputs: string[];
  t: number;
}): Promise<Omit<PerFileResult, "resolution">> {
  // Pass 2 — per-file emit. Every module is its own entry; all imports external.
  await esbuild.build({
    ...frontendTsconfig(routesPath),
    entryPoints: modules,
    absWorkingDir: REPO_ROOT,
    outdir: `${staging}/js/m`,
    outbase: REPO_ROOT,
    entryNames: "[dir]/[name]",
    bundle: true,
    treeShaking: true,
    format: "esm",
    minify: true,
    sourcemap: false, // renaming for the hash breaks the linked URL; revisit (Phase 3)
    logLevel: "warning",
    plugins: [externalizeAndRewrite(), new SvgLoaderPlugin()],
  });
  t = phase("pass 2 emit", t);

  // Type-only-import shim. esbuild strips type-only exports per module, but in
  // ISOLATION (per-file) it can't tell that an importer's `import { T }` /
  // `export { T } from` references a type — only the whole-program bundle elides
  // those. So a named import whose target doesn't actually export it (a pure-type
  // module → 0 bytes, or a value+type module missing the stripped type) would 404
  // the export at runtime. Reconstruct the surface: validate every named import
  // against the target's real (`export *`-resolved) exports and append
  // `export const <name> = void 0` to the target for each missing name. Those
  // names are only referenced in type positions (every value use was stripped),
  // so the runtime `undefined` is never read — it just makes the binding resolve.
  // Runs before hashing so the stubs are what get hashed.
  {
    const relOf = (abs: string) => stripExt(repoRel(abs));
    const pathOf = (rel: string) => `${staging}/js/m/${rel}.js`;
    const allRels = modules.map(relOf);
    const bodyOf = new Map<string, string>();
    for (const rel of allRels) bodyOf.set(rel, await Deno.readTextFile(pathOf(rel)));

    // `export{a,b as c}` (local OR `… from` re-export) both export the LAST name.
    const EXPORT_NAMES = /export\s*\{([^}]*)\}/g;
    const EXPORT_DECL =
      /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    const EXPORT_STAR = /export\s*\*\s*(?:as\s+[\w$]+\s+)?from\s*"(@m\/[^"]+)"/g;
    const NAMED_FROM = /(?:import|export)\s*\{([^}]*)\}\s*from\s*"(@m\/[^"]+)"/g;

    const directExports = new Map<string, Set<string>>();
    const starTargets = new Map<string, string[]>();
    for (const rel of allRels) {
      const b = bodyOf.get(rel)!;
      const ex = new Set<string>();
      for (const m of b.matchAll(EXPORT_NAMES)) {
        for (const e of m[1].split(",")) {
          const n = e.trim().split(/\s+as\s+/).pop()!.trim();
          if (n) ex.add(n);
        }
      }
      for (const m of b.matchAll(EXPORT_DECL)) ex.add(m[1]);
      if (/export\s+default\b/.test(b)) ex.add("default");
      directExports.set(rel, ex);
      starTargets.set(rel, [...b.matchAll(EXPORT_STAR)].map((m) => m[1].slice(3)));
    }
    const fullExports = new Map<string, Set<string>>();
    const resolveExports = (rel: string, seen = new Set<string>()): Set<string> => {
      const cached = fullExports.get(rel);
      if (cached) return cached;
      if (seen.has(rel)) return new Set();
      seen.add(rel);
      const out = new Set(directExports.get(rel) ?? []);
      for (const t of starTargets.get(rel) ?? []) {
        for (const n of resolveExports(t, seen)) out.add(n);
      }
      fullExports.set(rel, out);
      return out;
    };

    const missing = new Map<string, Set<string>>();
    for (const rel of allRels) {
      for (const m of bodyOf.get(rel)!.matchAll(NAMED_FROM)) {
        const tRel = m[2].slice(3);
        if (!directExports.has(tRel)) continue; // external/vendor target — leave alone
        const provided = resolveExports(tRel);
        for (const e of m[1].split(",")) {
          const name = e.trim().split(/\s+as\s+/)[0].trim(); // the target's export name
          if (name && name !== "default" && !provided.has(name)) {
            if (!missing.has(tRel)) missing.set(tRel, new Set());
            missing.get(tRel)!.add(name);
          }
        }
      }
    }
    for (const [rel, names] of missing) {
      const b = bodyOf.get(rel)!;
      const stub = [...names].map((n) => `export const ${n}=void 0;`).join("");
      await Deno.writeTextFile(pathOf(rel), b + (b.length ? "\n" : "") + stub);
    }
  }

  t = phase("type-only shim", t);

  // Hash + rename each emitted file; build logical-id → hashed-URL map.
  const importMap: Record<string, string> = {};
  const urlByLogicalId: Record<string, string> = {};
  for (const abs of modules) {
    const rel = stripExt(repoRel(abs)); // tento/tento-ui-js/cookies
    const emitted = `${staging}/js/m/${rel}.js`;
    const bytes = await Deno.readFile(emitted);
    const hash = await sha8(bytes);
    const hashedAbs = `${outRoot}/js/m/${rel}.${hash}.js`;
    await ensureDir(dirname(hashedAbs));
    // Same filesystem (the staging dir is inside the store), so this is an
    // atomic replace of identical bytes when the module already exists.
    await Deno.rename(emitted, hashedAbs);
    const logicalId = "@m/" + rel;
    const url = `/js/m/${rel}.${hash}.js`;
    importMap[logicalId] = url;
    urlByLogicalId[logicalId] = url;
  }

  t = phase("hash + move into store", t);

  // Per-root preload manifest = the ACTUAL runtime fetch closure, computed by
  // walking the *emitted* import statements from each root's entry. We do NOT
  // use the pass-1 metafile's per-output inputs: that's esbuild's whole-program
  // tree-shaken graph, but per-file emit keeps each module's full export surface
  // (entries aren't export-shaken), so a few modules the monolith shook out of a
  // root survive in the per-file runtime. Deriving preload from the emit graph
  // guarantees the manifest lists exactly what the browser will fetch.
  const bodyCache = new Map<string, string>();
  const readBody = async (url: string): Promise<string> => {
    const cached = bodyCache.get(url);
    if (cached !== undefined) return cached;
    const body = await Deno.readTextFile(`${outRoot}${url}`);
    bodyCache.set(url, body);
    return body;
  };
  const closureFrom = async (entryUrl: string): Promise<string[]> => {
    const visited = new Set<string>();
    const stack = [entryUrl];
    while (stack.length > 0) {
      const url = stack.pop()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const body = await readBody(url);
      const specs = new Set<string>();
      for (const m of body.matchAll(IMPORT_SPEC_RE)) specs.add(m[1]);
      for (const spec of specs) {
        if (!spec.startsWith("@m/")) continue; // inlined assets / external URLs
        const target = importMap[spec];
        if (!target) {
          // Fail closed: an emitted body references a module we didn't emit.
          // (Per-file retained an import the whole-program graph shook out.)
          throw new Error(
            `perfile: dangling import "${spec}" in ${url} — module not emitted`,
          );
        }
        if (!visited.has(target)) stack.push(target);
      }
    }
    return [...visited].sort();
  };

  const resultRoots: PerFileResult["roots"] = [];
  for (const rootAbs of roots) {
    const rootLogicalId = logicalIdFor(rootAbs);
    const entryUrl = urlByLogicalId[rootLogicalId];
    if (!entryUrl) continue;
    const preload = await closureFrom(entryUrl);
    // `foo/index.root.ts` → `index.root.js`: the root's own name is the only
    // authoritative source for the bundle script, and the script is what ties a
    // root to its HTML.
    const rootRel = relative(routesPath, rootAbs);
    const scriptBase = basename(rootRel).replace(/\.root\.tsx?$/, ".root.js");
    // Fall back to the old name-rewrite when no HTML claims this root, so a
    // route whose HTML is generated later still gets its previous (skipped)
    // behaviour rather than a crash.
    const htmlRel = (await findEntryHtml(routesPath, rootAbs, scriptBase)) ??
      rootRel.replace(/\.root\.tsx?$/, ".html");
    resultRoots.push({ rootLogicalId, entryUrl, preload, htmlRel, scriptBase });
  }

  phase("closures + entry HTML", t);
  return { importMap, roots: resultRoots, inputs };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The route HTML that boots `rootAbs`, relative to `routesPath`.
 *
 * This is NOT derivable from the root's filename, and assuming it was is why
 * the per-file build emitted zero `*.unbundled.html` manifests for every
 * loopback miniapp. Two conventions coexist: tento-web's product routes pair
 * `index.anon.root.ts` with `index.anon.html` (so a `.root.ts` → `.html`
 * rewrite happens to work), while every `.node` app pairs a hand-authored
 * `index.anon.html` with `index.root.ts` (so the rewrite named `index.html`,
 * which does not exist). Each root then took the "no bundled HTML" skip —
 * silently, because the emit step is best-effort by design.
 *
 * The link that actually holds in both directions is the bundle script: the
 * HTML names it in a `<script src>`, and its name comes from the root. So match
 * on that rather than guessing a filename. Returns null when nothing claims the
 * root, which is a real condition for a route whose HTML is generated later. */
async function findEntryHtml(
  routesPath: string,
  rootAbs: string,
  scriptBase: string,
): Promise<string | null> {
  const dir = dirname(rootAbs);
  const re = new RegExp(`<script[^>]*src="[^"]*${escapeRe(scriptBase)}"`);
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".html")) names.push(e.name);
    }
  } catch {
    return null;
  }
  // Sorted so a directory with several candidates resolves the same way on
  // every machine — readDir order is not specified.
  names.sort();
  for (const name of names) {
    const abs = join(dir, name);
    let text: string;
    try {
      text = await Deno.readTextFile(abs);
    } catch {
      continue;
    }
    if (re.test(text)) return relative(routesPath, abs);
  }
  return null;
}

// Build the unbundled entry HTML: take the bundled route HTML and swap its single
// `<script src=".../<name>.root.js">` for an inline import map, a modulepreload
// manifest covering the root's static closure, and a module `<script>` pointing
// at the hashed entry URL. Import maps resolve only bare `@m/` specifiers inside
// modules; the document's own `<script src>` must be a real URL — hence the
// hashed `entryUrl`.
export function injectUnbundledHtml(
  bundledHtml: string,
  root: PerFileResult["roots"][number],
  importMap: Record<string, string>,
): string {
  const importMapTag = `<script type="importmap">${
    JSON.stringify({ imports: importMap })
  }</script>`;
  const preloadTags = root.preload
    .map((u) => `<link rel="modulepreload" href="${u}">`)
    .join("\n");
  const entryTag =
    `<script type="module" src="${root.entryUrl}" blocking="render"></script>`;
  const injection = `${importMapTag}\n${preloadTags}\n${entryTag}`;

  // From the ROOT, not from `htmlRel`. Re-deriving it from the HTML name gave
  // `index.anon.root.js` for a route whose script is `index.root.js`, so the
  // match below would have thrown "bundle <script> not found" on exactly the
  // routes the `htmlRel` fix just made reachable.
  const base = root.scriptBase;
  const esc = escapeRe(base);
  // Drop any bundle-entry preload hint (`<link rel="modulepreload" href="/…root.js">`
  // — e.g. calendar's `fetchpriority="high"` cold-start hint). The unbundled HTML
  // supplies its own `/js/m/` modulepreloads; leaving the bundle preload would fetch
  // the monolith alongside the per-file graph. The trailing `"` in the match excludes
  // the hashed unbundled entry (`…/index.root.<hash>.js"`), which has no `root.js"` tail.
  const html = bundledHtml.replace(
    new RegExp(`[ \\t]*<link\\b[^>]*href="[^"]*${esc}"[^>]*>\\n?`, "g"),
    "",
  );
  const re = new RegExp(`<script[^>]*src="[^"]*${esc}"[^>]*></script>`);
  if (!re.test(html)) {
    throw new Error(`inject: bundle <script> for ${base} not found in HTML`);
  }
  return html.replace(re, injection);
}

export type EmitResult = {
  modules: number;
  roots: PerFileResult["roots"];
  // Route-relative `*.unbundled.html` manifests written under `betaDir`.
  injected: string[];
  // Roots whose bundled HTML was absent from `betaDir`.
  skipped: string[];
  // Store URLs (`/js/m/...`) the manifests reference: every import-map value.
  storeFiles: string[];
  inputs: string[];
  resolution: ResolutionEvidence;
};

/**
 * The whole per-file step for one html root: emit into the store, write the
 * store's `import-map.json` / `perfile-roots.json`, and inject each root's
 * `*.unbundled.html` beside its bundled HTML in `betaDir`. Shared by the CLI
 * below and the bundler worker's `perfile` RPC; throws on any emit failure.
 */
export async function emitPerFile({
  routesPath,
  store,
  betaDir,
  log = () => {},
}: {
  routesPath: string;
  store: string;
  betaDir?: string;
  log?: (line: string) => void;
}): Promise<EmitResult> {
  const result = await buildPerFile({ routesPath, outRoot: store });
  // Shared by every domain emitting into this store; the last writer wins, as
  // before, but a reader never sees a torn file.
  await writeAtomic(
    `${store}/import-map.json`,
    JSON.stringify({ imports: result.importMap }, null, 2),
  );
  await writeAtomic(`${store}/perfile-roots.json`, JSON.stringify(result.roots, null, 2));
  log(
    `perfile: emitted ${Object.keys(result.importMap).length} modules, ${result.roots.length} roots → ${store}`,
  );
  for (const r of result.roots) {
    log(`  ${r.rootLogicalId} → ${r.entryUrl} (${r.preload.length} preload)`);
  }

  const injected: string[] = [];
  const skipped: string[] = [];
  if (betaDir) {
    for (const r of result.roots) {
      const bundledPath = `${betaDir}/${r.htmlRel}`;
      let bundledHtml: string;
      try {
        bundledHtml = await Deno.readTextFile(bundledPath);
      } catch {
        log(`  skip ${r.htmlRel} (no bundled HTML at ${bundledPath})`);
        skipped.push(r.htmlRel);
        continue;
      }
      const outRel = r.htmlRel.replace(/\.html$/, ".unbundled.html");
      const outPath = `${betaDir}/${outRel}`;
      await Deno.writeTextFile(outPath, injectUnbundledHtml(bundledHtml, r, result.importMap));
      log(`  inject → ${outPath}`);
      injected.push(outRel);
    }
  }

  return {
    modules: Object.keys(result.importMap).length,
    roots: result.roots,
    injected,
    skipped,
    storeFiles: [...new Set(Object.values(result.importMap))].sort(),
    inputs: result.inputs,
    resolution: result.resolution,
  };
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, contents);
  await Deno.rename(tmp, path);
}

if (import.meta.main) {
  const args = Deno.args;
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const routesPath = get("--routes");
  // `--store` = content-addressed module store (emit root); `--out` is a legacy
  // alias for standalone runs.
  const store = get("--store") ?? get("--out");
  // `--beta-dir` = the route's dir in the beta tree; if given, write the
  // `*.unbundled.html` manifest(s) there next to the bundled HTML.
  const betaDir = get("--beta-dir");
  if (!routesPath || !store) {
    console.error(
      "usage: bundler-perfile.deno.ts --routes <dir> --store <module-store> [--beta-dir <beta-route-dir>]",
    );
    Deno.exit(2);
  }
  await emitPerFile({ routesPath, store, betaDir, log: (line) => console.error(line) });
  await esbuild.stop();
  Deno.exit(0);
}
