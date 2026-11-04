// What esbuild's resolver consulted, for the reuse stamp (frontend-build-emitter
// O08, `bundler_reuse.rs`).
//
// A metafile names the files a build read, not the places the resolver looked
// first and found nothing. Those matter: `"@a/*": ["./first/*", "./second/*"]`
// resolves `@a/x` to `second/x.ts` only while `first/x.ts` is absent, and a
// stamp that hashes `second/x.ts` alone would keep vouching for the old bundle
// after `first/x.ts` appears. esbuild does not report its probes, so this
// replays its resolution algorithm (v0.24, `internal/resolver/resolver.go`) for
// every import edge in the metafile and records each path the replay
// consulted before it reached the file esbuild chose.
//
// The replay is checked against esbuild itself: an edge counts only when the
// replay arrives at the very file esbuild resolved (after symlinks). An edge
// the replay cannot follow — `exports`/`imports` maps, `browser` maps, globs,
// query suffixes, a different-case match, a tie between `paths` patterns — is
// reported as unsupported, and the Rust side then writes no stamp: reuse
// misses rather than trust a resolution it cannot vouch for.

import { dirname, isAbsolute, join, resolve } from "jsr:@std/path";

export type Kind = "file" | "dir" | "other";

type MetafileImport = {
  path: string;
  kind: string;
  external?: boolean;
  original?: string;
};

export type Metafile = {
  inputs: Record<string, { imports?: MetafileImport[] }>;
};

export type ResolutionEvidence = {
  /** Every path whose existence (or kind) a replayed resolution consulted,
   * with the kind the replay saw there (`null`: no such entry). Each replay
   * lists a directory once, so every observation is of this build. */
  probes: Array<[string, Kind | null]>;
  /** package.json files whose contents a replayed resolution read. */
  reads: string[];
  /** Candidate spelling → real path, for results reached through a symlink. */
  links: Array<[string, string]>;
  /** Why some edge could not be replayed (first few); empty = all verified. */
  unsupported: string[];
  /** Import edges replayed (after deduplication by directory and specifier). */
  edges: number;
};

class Unsupported extends Error {}

const DEFAULT_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];
const CSS_EXTENSIONS = [".css"];
const REWRITTEN: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const MAX_REASONS = 20;

type Tsconfig = {
  file: string;
  paths?: Record<string, string[]>;
  /** Where relative `paths` targets resolve from when there is no baseUrl. */
  pathsBase?: string;
  baseUrl?: string;
};

/** JSON with comments and trailing commas, as TypeScript and esbuild read it. */
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export class ResolutionReplay {
  #entries = new Map<string, Map<string, { name: string; kind: Kind }> | null>();
  #packages = new Map<string, Record<string, unknown> | null>();
  #tsconfigs = new Map<string, Tsconfig>();
  #discovered = new Map<string, Tsconfig | null>();
  #browserChecked = new Set<string>();
  #edgeCache = new Map<
    string,
    { result: string | null; probes: Array<[string, Kind | null]>; reads: string[] }
  >();
  #realpaths = new Map<string, string | null>();
  // Probes of the edge being replayed, with what each found; merged into the
  // totals only when the replay reproduced esbuild's answer.
  #probes = new Map<string, Kind | null>();
  #reads = new Set<string>();

  readonly probes = new Map<string, Kind | null>();
  readonly reads = new Set<string>();
  readonly links = new Map<string, string>();
  readonly reasons = new Set<string>();
  unsupportedCount = 0;
  edges = 0;

  constructor(private readonly forcedTsconfig?: string) {}

  /** Replay every import edge of one build's metafile. `cwd` is the build's
   * working directory, which metafile paths are relative to. */
  addMetafile(metafile: Metafile | undefined, cwd: string): void {
    if (!metafile) {
      this.#refuse("build returned no metafile");
      return;
    }
    for (const [key, input] of Object.entries(metafile.inputs)) {
      const imports = input.imports ?? [];
      if (isNamespaced(key)) {
        if (imports.length > 0) this.#refuse(`${key}: imports from a plugin namespace`);
        continue;
      }
      const importer = resolve(cwd, key);
      for (const edge of imports) {
        if (edge.external) {
          if (/^(https?:|data:|\/\/)/.test(edge.path)) continue;
          // An import a TypeScript file never uses as a value is dropped before
          // resolution; the metafile lists it as external under the specifier
          // as written, with no `original` (measured on esbuild 0.24). Nothing
          // was looked up, so nothing is recorded. These builds configure no
          // externals, so any other external is something unknown.
          if (
            /\.[mc]?tsx?$/.test(key) &&
            (edge.original === undefined || edge.original === edge.path)
          ) continue;
          this.#refuse(`${key}: external import ${edge.path}`);
          continue;
        }
        if (edge.original === undefined) {
          this.#refuse(`${key}: metafile import without its original specifier`);
          continue;
        }
        if (isNamespaced(edge.path)) {
          this.#refuse(`${key}: ${edge.original} resolved into a plugin namespace`);
          continue;
        }
        this.#replay(importer, edge.original, edge.kind, resolve(cwd, edge.path));
      }
    }
  }

  evidence(): ResolutionEvidence {
    const unsupported = [...this.reasons];
    if (this.unsupportedCount > unsupported.length) {
      unsupported.push(`… ${this.unsupportedCount - unsupported.length} more`);
    }
    return {
      probes: [...this.probes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      reads: [...this.reads].sort(),
      links: [...this.links].sort(),
      unsupported,
      edges: this.edges,
    };
  }

  #refuse(reason: string): void {
    this.unsupportedCount++;
    if (this.reasons.size < MAX_REASONS) this.reasons.add(reason);
  }

  #replay(importer: string, specifier: string, kind: string, expected: string): void {
    const sourceDir = dirname(importer);
    const css = kind === "import-rule" || kind === "composes-from" || kind === "url-token";
    const key = `${sourceDir}\0${specifier}\0${kind}`;
    let cached = this.#edgeCache.get(key);
    if (!cached) {
      this.edges++;
      cached = { result: null, probes: [], reads: [] };
      try {
        // A file inside node_modules may or may not see the app's tsconfig
        // `paths` (a forced tsconfig does not apply there, measured on
        // esbuild 0.24); every variant that reproduces esbuild's answer
        // contributes its probes.
        const variants = this.#tsconfigVariants(sourceDir);
        let matched = false;
        for (const ts of variants) {
          this.#probes = new Map();
          this.#reads = new Set();
          const result = this.#resolve(sourceDir, specifier, kind, css, ts);
          if (result !== null && this.#realpath(result) === expected) {
            matched = true;
            cached.result = result;
            cached.probes.push(...this.#probes);
            cached.reads.push(...this.#reads);
          }
        }
        if (!matched) {
          throw new Unsupported(`replay did not reach ${expected}`);
        }
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        cached.result = null;
        cached.probes = [];
        cached.reads = [];
        this.#refuse(`${importer}: ${JSON.stringify(specifier)}: ${e.message}`);
      }
      this.#edgeCache.set(key, cached);
    }
    if (cached.result === null) return;
    for (const [p, kind] of cached.probes) this.probes.set(p, kind);
    for (const r of cached.reads) this.reads.add(r);
    if (cached.result !== expected) this.links.set(cached.result, expected);
  }

  // --- the algorithm -------------------------------------------------------

  #resolve(
    sourceDir: string,
    specifier: string,
    kind: string,
    css: boolean,
    ts: Tsconfig | null,
  ): string | null {
    const extensions = kind === "import-rule" || kind === "composes-from"
      ? CSS_EXTENSIONS
      : DEFAULT_EXTENSIONS;
    if (specifier.includes("*")) throw new Unsupported("glob import");
    if (/[?#]/.test(specifier.slice(1))) throw new Unsupported("query or hash suffix");
    if (specifier.startsWith("/")) {
      if (ts?.paths) {
        const hit = this.#matchPaths(ts, specifier, extensions, kind);
        if (hit !== null) return hit;
      }
      return this.#loadAsFileOrDirectory(specifier, extensions, kind);
    }
    const isPackage = !(specifier.startsWith("./") || specifier.startsWith("../") ||
      specifier === "." || specifier === "..");
    if (!isPackage || css) {
      const abs = join(sourceDir, specifier);
      this.#checkBrowserScope(dirname(abs));
      const hit = this.#loadAsFileOrDirectory(abs, extensions, kind);
      if (hit !== null || !isPackage) return hit;
    }
    this.#checkBrowserScope(sourceDir);
    return this.#loadNodeModules(specifier, sourceDir, extensions, kind, ts);
  }

  #loadNodeModules(
    specifier: string,
    sourceDir: string,
    extensions: string[],
    kind: string,
    ts: Tsconfig | null,
  ): string | null {
    if (ts) {
      if (ts.paths) {
        const hit = this.#matchPaths(ts, specifier, extensions, kind);
        if (hit !== null) return hit;
      }
      if (ts.baseUrl) {
        const hit = this.#loadAsFileOrDirectory(join(ts.baseUrl, specifier), extensions, kind);
        if (hit !== null) return hit;
      }
    }
    if (specifier.startsWith("#")) throw new Unsupported("package.json subpath import");
    const name = packageName(specifier);
    if (name === null) throw new Unsupported("not a package name");
    const enclosing = this.#nearestPackage(sourceDir);
    if (enclosing && enclosing.name === name && enclosing.exports !== undefined) {
      throw new Unsupported("package self-reference through exports");
    }
    for (const dir of ancestors(sourceDir)) {
      if (basename(dir) === "node_modules") continue;
      const modules = join(dir, "node_modules");
      if (this.#kind(modules) !== "dir") continue;
      const pkgDir = join(modules, name);
      if (this.#kind(pkgDir) === "dir") {
        const pkg = this.#package(pkgDir);
        if (pkg?.exports !== undefined) throw new Unsupported(`package ${name} has an exports map`);
        if (pkg && typeof pkg.browser === "object" && pkg.browser !== null) {
          throw new Unsupported(`package ${name} has a browser map`);
        }
      }
      const hit = this.#loadAsFileOrDirectory(join(modules, specifier), extensions, kind);
      if (hit !== null) return hit;
    }
    return null;
  }

  #matchPaths(ts: Tsconfig, specifier: string, extensions: string[], kind: string): string | null {
    const paths = ts.paths!;
    const base = ts.baseUrl ?? ts.pathsBase!;
    const target = (t: string) => (isAbsolute(t) ? t : join(base, t));
    for (const [key, targets] of Object.entries(paths)) {
      if (key === specifier) {
        for (const t of targets) {
          const hit = this.#loadAsFileOrDirectory(target(t), extensions, kind);
          if (hit !== null) return hit;
        }
        return null;
      }
    }
    let best: { prefix: string; suffix: string; targets: string[] } | null = null;
    let tied = false;
    for (const [key, targets] of Object.entries(paths)) {
      const star = key.indexOf("*");
      if (star === -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      if (specifier.length < prefix.length + suffix.length) continue;
      if (
        best === null || prefix.length > best.prefix.length ||
        (prefix.length === best.prefix.length && suffix.length > best.suffix.length)
      ) {
        best = { prefix, suffix, targets };
        tied = false;
      } else if (prefix.length === best.prefix.length && suffix.length === best.suffix.length) {
        tied = true;
      }
    }
    if (best === null) return null;
    if (tied) throw new Unsupported("two tsconfig paths patterns match equally");
    const matched = specifier.slice(best.prefix.length, specifier.length - best.suffix.length);
    for (const t of best.targets) {
      const hit = this.#loadAsFileOrDirectory(target(t.replace("*", matched)), extensions, kind);
      if (hit !== null) return hit;
    }
    return null;
  }

  #loadAsFileOrDirectory(path: string, extensions: string[], kind: string): string | null {
    const file = this.#loadAsFile(path, extensions);
    if (file !== null) return file;
    if (this.#kind(path) !== "dir") return null;
    const pkg = this.#package(path);
    if (pkg) {
      const main = this.#loadAsMainField(path, pkg, extensions, kind);
      if (main !== null) return main;
    }
    return this.#loadAsIndex(path, extensions);
  }

  #loadAsFile(path: string, extensions: string[]): string | null {
    if (this.#kind(path) === "file") return path;
    for (const ext of extensions) {
      if (this.#kind(path + ext) === "file") return path + ext;
    }
    const dot = path.lastIndexOf(".");
    if (dot > path.lastIndexOf("/")) {
      for (const ext of REWRITTEN[path.slice(dot)] ?? []) {
        const candidate = path.slice(0, dot) + ext;
        if (this.#kind(candidate) === "file") return candidate;
      }
    }
    return null;
  }

  #loadAsIndex(dir: string, extensions: string[]): string | null {
    for (const ext of extensions) {
      const candidate = join(dir, "index" + ext);
      if (this.#kind(candidate) === "file") return candidate;
    }
    return null;
  }

  #loadAsMainField(
    dir: string,
    pkg: Record<string, unknown>,
    extensions: string[],
    kind: string,
  ): string | null {
    if (typeof pkg.browser === "object" && pkg.browser !== null) {
      throw new Unsupported(`${dir}/package.json has a browser map`);
    }
    const fields = ["browser", "module", "main"].filter((f) => typeof pkg[f] === "string");
    if (
      (kind === "require-call" || kind === "require-resolve") &&
      fields.includes("module") && fields.includes("main")
    ) {
      throw new Unsupported("require of a package with both module and main");
    }
    for (const field of fields) {
      const abs = join(dir, pkg[field] as string);
      const file = this.#loadAsFile(abs, extensions);
      if (file !== null) return file;
      if (this.#kind(abs) === "dir") {
        const index = this.#loadAsIndex(abs, extensions);
        if (index !== null) return index;
      }
    }
    return null;
  }

  // --- configuration -------------------------------------------------------

  #tsconfigVariants(sourceDir: string): Array<Tsconfig | null> {
    const ts = this.forcedTsconfig
      ? this.#loadTsconfig(this.forcedTsconfig)
      : this.#discoverTsconfig(sourceDir);
    if (!ts) return [null];
    return sourceDir.split("/").includes("node_modules") ? [ts, null] : [ts];
  }

  /** The nearest tsconfig.json (else jsconfig.json) above a directory, as
   * esbuild finds it when no tsconfig is forced. */
  #discoverTsconfig(dir: string): Tsconfig | null {
    if (this.#discovered.has(dir)) {
      const found = this.#discovered.get(dir)!;
      // Replays the probes the first lookup made.
      for (const d of ancestors(dir)) {
        this.#kind(join(d, "tsconfig.json"));
        this.#kind(join(d, "jsconfig.json"));
        if (found && dirname(found.file) === d) break;
      }
      return found;
    }
    let found: Tsconfig | null = null;
    for (const d of ancestors(dir)) {
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        if (this.#kind(join(d, name)) === "file") {
          found = this.#loadTsconfig(join(d, name));
          break;
        }
      }
      if (found) break;
    }
    this.#discovered.set(dir, found);
    return found;
  }

  #loadTsconfig(file: string, depth = 0): Tsconfig {
    const cached = this.#tsconfigs.get(file);
    if (cached) return cached;
    if (depth > 16) throw new Unsupported(`${file}: extends chain too deep`);
    let raw: Record<string, unknown>;
    try {
      raw = parseJsonc(Deno.readTextFileSync(file)) as Record<string, unknown>;
    } catch (e) {
      throw new Unsupported(`${file} does not parse: ${e}`);
    }
    let merged: Tsconfig = { file };
    const extendsField = raw.extends;
    const bases = typeof extendsField === "string"
      ? [extendsField]
      : Array.isArray(extendsField)
      ? extendsField
      : extendsField === undefined
      ? []
      : null;
    if (bases === null) throw new Unsupported(`${file}: unexpected extends`);
    for (const base of bases) {
      if (typeof base !== "string" || !/^(\.\.?\/|\/)/.test(base)) {
        throw new Unsupported(`${file} extends package ${JSON.stringify(base)}`);
      }
      let target = resolve(dirname(file), base);
      try {
        if (!Deno.statSync(target).isFile) throw new Error();
      } catch {
        target += ".json";
      }
      const parent = this.#loadTsconfig(target, depth + 1);
      merged = { ...merged, ...withoutFile(parent) };
    }
    const options = (raw.compilerOptions ?? {}) as Record<string, unknown>;
    if (typeof options.baseUrl === "string") {
      merged.baseUrl = resolve(dirname(file), options.baseUrl);
    }
    if (options.paths !== undefined) {
      if (typeof options.paths !== "object" || options.paths === null) {
        throw new Unsupported(`${file}: paths is not an object`);
      }
      merged.paths = options.paths as Record<string, string[]>;
      merged.pathsBase = dirname(file);
    }
    merged.file = file;
    this.#tsconfigs.set(file, merged);
    return merged;
  }

  #package(dir: string): Record<string, unknown> | null {
    const file = join(dir, "package.json");
    const present = this.#kind(file) === "file";
    if (present) this.#reads.add(file);
    if (this.#packages.has(dir)) return this.#packages.get(dir)!;
    let pkg: Record<string, unknown> | null = null;
    if (present) {
      try {
        pkg = JSON.parse(Deno.readTextFileSync(file));
      } catch (e) {
        throw new Unsupported(`${file} does not parse: ${e}`);
      }
      if (typeof pkg !== "object" || pkg === null) pkg = {};
    }
    this.#packages.set(dir, pkg);
    return pkg;
  }

  #nearestPackage(dir: string): Record<string, unknown> | null {
    for (const d of ancestors(dir)) {
      const pkg = this.#package(d);
      if (pkg) return pkg;
    }
    return null;
  }

  /** esbuild applies the `browser` map of any package.json above a file; the
   * replay does not model those maps. */
  #checkBrowserScope(dir: string): void {
    for (const d of ancestors(dir)) {
      const pkg = this.#package(d);
      if (this.#browserChecked.has(d)) continue;
      this.#browserChecked.add(d);
      if (pkg && typeof pkg.browser === "object" && pkg.browser !== null) {
        throw new Unsupported(`${d}/package.json has a browser map`);
      }
    }
  }

  // --- the filesystem, as esbuild sees it -----------------------------------

  /** The kind of `path`, looked up the way esbuild does: in its parent's
   * entries, case-insensitively, following symlinks. A match that differs
   * only in case is not something the replay models. */
  #kind(path: string): Kind | null {
    const kind = this.#lookup(path);
    this.#probes.set(path, kind);
    return kind;
  }

  #lookup(path: string): Kind | null {
    const parent = dirname(path);
    if (parent === path) return "dir";
    const entries = this.#list(parent);
    if (!entries) return null;
    const name = path.slice(parent === "/" ? 1 : parent.length + 1);
    const entry = entries.get(name.toLowerCase());
    if (!entry) return null;
    if (entry.name !== name) {
      throw new Unsupported(`${path} matches ${entry.name} only case-insensitively`);
    }
    return entry.kind;
  }

  #list(dir: string): Map<string, { name: string; kind: Kind }> | null {
    if (this.#entries.has(dir)) return this.#entries.get(dir)!;
    let entries: Map<string, { name: string; kind: Kind }> | null = null;
    try {
      entries = new Map();
      for (const entry of Deno.readDirSync(dir)) {
        let kind: Kind = entry.isDirectory ? "dir" : entry.isFile ? "file" : "other";
        if (entry.isSymlink) {
          try {
            const target = Deno.statSync(join(dir, entry.name));
            kind = target.isDirectory ? "dir" : target.isFile ? "file" : "other";
          } catch {
            kind = "other";
          }
        }
        entries.set(entry.name.toLowerCase(), { name: entry.name, kind });
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound || e instanceof Deno.errors.NotADirectory)) throw e;
      entries = null;
    }
    this.#entries.set(dir, entries);
    return entries;
  }

  #realpath(path: string): string | null {
    if (!this.#realpaths.has(path)) {
      try {
        this.#realpaths.set(path, Deno.realPathSync(path));
      } catch {
        this.#realpaths.set(path, null);
      }
    }
    return this.#realpaths.get(path)!;
  }
}

function withoutFile(ts: Tsconfig): Omit<Tsconfig, "file"> {
  const { file: _file, ...rest } = ts;
  return rest;
}

function isNamespaced(path: string): boolean {
  return /^[a-z-]+:/.test(path);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function* ancestors(dir: string): Generator<string> {
  let d = dir;
  while (true) {
    yield d;
    const parent = dirname(d);
    if (parent === d) return;
    d = parent;
  }
}

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageName(specifier: string): string | null {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 && parts[0].length > 1 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] ? parts[0] : null;
}

/** Replay one build's metafile. */
export function resolutionEvidence(
  metafile: Metafile | undefined,
  cwd: string,
  tsconfig: string | undefined,
): ResolutionEvidence {
  const replay = new ResolutionReplay(tsconfig);
  replay.addMetafile(metafile, cwd);
  return replay.evidence();
}

// `deno run -A bundler-resolution.deno.ts <routes dir>`: bundle the routes dir
// as the worker does (no output written) and print what the replay found.
if (import.meta.main) {
  const esbuild = await import("https://deno.land/x/esbuild@v0.24.0/mod.js");
  const { expandGlob } = await import("jsr:@std/fs");
  const { frontendTsconfig } = await import("./frontend-tsconfig.deno.ts");
  const { SvgLoaderPlugin } = await import("../../../tento-web-js/build-plugins/svg-loader.deno.ts");
  const routesPath = resolve(Deno.args[0]);
  const entryPoints = (await Array.fromAsync(expandGlob(`${routesPath}/**/*.root.ts`))).map((p) =>
    p.path
  );
  const config = frontendTsconfig(routesPath);
  const result = await esbuild.build({
    ...config,
    entryPoints,
    outdir: "/nonexistent-out",
    outbase: routesPath,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    logLevel: "error",
    plugins: [new SvgLoaderPlugin()],
  });
  const started = performance.now();
  const evidence = resolutionEvidence(result.metafile, Deno.cwd(), config.tsconfig);
  console.log(JSON.stringify({
    inputs: Object.keys(result.metafile!.inputs).length,
    edges: evidence.edges,
    probes: evidence.probes.length,
    reads: evidence.reads.length,
    links: evidence.links.length,
    unsupported: evidence.unsupported,
    replayMs: Math.round(performance.now() - started),
  }, null, 1));
  await esbuild.stop();
}
