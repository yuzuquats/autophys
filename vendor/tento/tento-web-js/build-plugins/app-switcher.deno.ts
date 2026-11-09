import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

import { dirname, isAbsolute, join, relative, resolve } from "jsr:@std/path";

/**
 * # App switcher packaging: the switcher's apps are chosen when a site is built
 *
 * An app switcher (`std-app-switcher`, tento-brand-js kit) shows a card of
 * sibling apps: their names, links and icons. Which apps a site lists, and
 * whether it lists any, is a packaging decision of that site, not something
 * the component or a shared library hard-codes. A site declares it in two
 * checked-in files beside its routes directory (`html/` for `html/routes`):
 *
 * - `app-switcher.json` — the data model: an optional `label` (the chevron's
 *   accessible name) and the `apps` in grid order, each with an `id`, a
 *   `name`, an `http(s)` `href` and an `icon` (an `.svg` file, relative to
 *   the manifest and inside its directory).
 * - `app-switcher.env` — the switch: `TENTO_APP_SWITCHER=on` bundles the
 *   apps' links and icons; `off` bundles none of them. The process
 *   environment's `TENTO_APP_SWITCHER` overrides the file, so a packager can
 *   build either way from the same tree. With neither, the switcher is off.
 *
 * This plugin replaces any module whose path ends in `app-switcher.packaged.ts`
 * (on disk, `tento-brand-js/kit/app-switcher.packaged.ts`, which exports
 * `undefined`) with the packaged model:
 *
 * - no manifest beside the routes: the module is left as it is (`undefined`,
 *   "this site does not configure a switcher"; a design may fall back to its
 *   own default);
 * - a manifest and the switch off: `null` (no switcher; nothing from the
 *   manifest is bundled);
 * - a manifest and the switch on: `{ label, apps }`, with every icon imported
 *   as text through the SVG loader, so the manifest and icons are inputs of
 *   the build like any other source file.
 *
 * A malformed manifest, an unknown switch value or a missing icon fails the
 * build with a message naming the file. The env file is read here, not
 * through `@std/dotenv/load`, because that loads the bundler worker's own
 * directory, not the site's. Like `BuildStampPlugin`, this is an `onLoad`
 * hook, so a watch rebuild re-reads both files. The per-file (`?fe=unbundled`)
 * emitter does not run plugins and serves the on-disk `undefined`.
 */
export class AppSwitcherPlugin implements esbuild.Plugin {
  name: string = "app-switcher";
  // A #private field: esbuild rejects a plugin object with own keys besides name and setup.
  readonly #configDir: string;

  /** `routesPath` is the routes directory being bundled; its parent holds the site's files. */
  constructor(routesPath: string) {
    this.#configDir = dirname(resolve(routesPath));
  }

  // An arrow field: esbuild calls `setup` detached from the plugin object.
  setup = (build: esbuild.PluginBuild): void => {
    build.onLoad(
      { filter: /[/\\]app-switcher\.packaged\.ts$/ },
      async (): Promise<esbuild.OnLoadResult | undefined> => {
        const packaged = await packageAppSwitcher(this.#configDir, envSwitch());
        if (packaged == null) return undefined;
        return { contents: packaged.contents, loader: "ts", watchFiles: packaged.watchFiles };
      },
    );
  };
}

export const APP_SWITCHER_ENV = "TENTO_APP_SWITCHER";
export const APP_SWITCHER_MANIFEST = "app-switcher.json";
export const APP_SWITCHER_ENV_FILE = "app-switcher.env";

/** One app as the manifest declares it. */
export interface ManifestApp {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  /** An `.svg` file, relative to the manifest. */
  readonly icon: string;
}

export interface Manifest {
  readonly label?: string;
  readonly apps: readonly ManifestApp[];
}

/**
 * The generated module for the site in `configDir`, or `null` when it has no
 * manifest (keep the on-disk module). `processSwitch` is the process
 * environment's `TENTO_APP_SWITCHER`, if set.
 */
export async function packageAppSwitcher(
  configDir: string,
  processSwitch: string | undefined,
): Promise<{ contents: string; watchFiles: string[] } | null> {
  const manifestPath = join(configDir, APP_SWITCHER_MANIFEST);
  const envPath = join(configDir, APP_SWITCHER_ENV_FILE);
  const manifestText = await readOptional(manifestPath);
  if (manifestText == null) return null;
  const watchFiles = [manifestPath, envPath];
  const fileSwitch = parseEnvFile(await readOptional(envPath) ?? "", envPath)[APP_SWITCHER_ENV];
  const raw = processSwitch ?? fileSwitch ?? "off";
  const on = parseSwitch(raw, processSwitch != null ? `$${APP_SWITCHER_ENV}` : envPath);
  if (!on) {
    return {
      contents: `// Packaged by AppSwitcherPlugin: ${APP_SWITCHER_ENV}=off.\nexport const PACKAGED_APP_SWITCHER = null;\n`,
      watchFiles,
    };
  }
  const manifest = parseManifest(manifestText, manifestPath);
  const icons: string[] = [];
  for (const app of manifest.apps) {
    const icon = resolve(configDir, app.icon);
    const inside = relative(configDir, icon);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`${manifestPath}: app ${JSON.stringify(app.id)}: icon ${JSON.stringify(app.icon)} is outside ${configDir}`);
    }
    try {
      if (!(await Deno.stat(icon)).isFile) throw new Deno.errors.NotFound(icon);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(`${manifestPath}: app ${JSON.stringify(app.id)}: icon ${JSON.stringify(app.icon)} does not exist`);
      }
      throw error;
    }
    icons.push(icon);
  }
  const imports = icons.map((icon, i) => `import icon${i} from ${JSON.stringify(icon)};`);
  const apps = manifest.apps.map((app, i) =>
    `  Object.freeze({ id: ${JSON.stringify(app.id)}, name: ${JSON.stringify(app.name)}, href: ${JSON.stringify(app.href)}, icon: icon${i} as string }),`
  );
  const contents = [
    `// Packaged by AppSwitcherPlugin from ${APP_SWITCHER_MANIFEST}: ${APP_SWITCHER_ENV}=on.`,
    ...imports,
    `export const PACKAGED_APP_SWITCHER = Object.freeze({`,
    `  label: ${JSON.stringify(manifest.label ?? null)},`,
    `  apps: Object.freeze([`,
    ...apps.map((line) => `  ${line}`),
    `  ]),`,
    `});`,
    ``,
  ].join("\n");
  return { contents, watchFiles: [...watchFiles, ...icons] };
}

/** `on` or `off` (also `1`/`0`, `true`/`false`, case-insensitive); anything else fails the build. */
export function parseSwitch(value: string, source: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true") return true;
  if (v === "off" || v === "0" || v === "false" || v === "") return false;
  throw new Error(`${source}: ${APP_SWITCHER_ENV}=${JSON.stringify(value)}; expected on or off`);
}

/** `KEY=value` lines; blank lines and `#` comments are skipped, and one pair of surrounding quotes is removed. */
export function parseEnvFile(text: string, source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (match == null) throw new Error(`${source}:${n + 1}: expected KEY=value`);
    let value = match[2];
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    out[match[1]] = value;
  }
  return out;
}

/** Validates the manifest's shape: unique ids, non-empty names, `http(s)` links and `.svg` icons. */
export function parseManifest(text: string, source: string): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: not JSON: ${(error as Error).message}`);
  }
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  if (typeof value !== "object" || value == null || Array.isArray(value)) fail("expected an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "label" && key !== "apps" && key !== "$comment") fail(`unknown key ${JSON.stringify(key)}`);
  }
  if (record.label != null && (typeof record.label !== "string" || record.label.trim() === "")) {
    fail("label must be a non-empty string");
  }
  if (!Array.isArray(record.apps)) fail("apps must be an array");
  const ids = new Set<string>();
  const apps = (record.apps as unknown[]).map((entry, i): ManifestApp => {
    const at = `apps[${i}]`;
    if (typeof entry !== "object" || entry == null || Array.isArray(entry)) fail(`${at}: expected an object`);
    const app = entry as Record<string, unknown>;
    for (const key of Object.keys(app)) {
      if (!["id", "name", "href", "icon"].includes(key)) fail(`${at}: unknown key ${JSON.stringify(key)}`);
    }
    for (const key of ["id", "name", "href", "icon"]) {
      if (typeof app[key] !== "string" || (app[key] as string).trim() === "") fail(`${at}: ${key} must be a non-empty string`);
    }
    const { id, name, href, icon } = app as unknown as ManifestApp;
    if (ids.has(id)) fail(`${at}: duplicate id ${JSON.stringify(id)}`);
    ids.add(id);
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      // reported below
    }
    if (url == null || (url.protocol !== "https:" && url.protocol !== "http:")) {
      fail(`${at}: href ${JSON.stringify(href)} must be an absolute http(s) URL`);
    }
    if (!icon.toLowerCase().endsWith(".svg")) fail(`${at}: icon ${JSON.stringify(icon)} must be an .svg file`);
    return { id, name, href, icon };
  });
  return { ...(record.label != null ? { label: record.label as string } : {}), apps };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function envSwitch(): string | undefined {
  try {
    return Deno.env.get(APP_SWITCHER_ENV);
  } catch {
    // No --allow-env: only the checked-in file decides.
    return undefined;
  }
}
