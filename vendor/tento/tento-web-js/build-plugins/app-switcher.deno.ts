import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

import { dirname, isAbsolute, join, relative, resolve, SEPARATOR as SEP } from "jsr:@std/path";

/**
 * # App switcher packaging: the switcher's apps are chosen when a site is built
 *
 * An app switcher (`std-app-switcher`, tento-brand-js kit) shows a card of
 * sibling apps: their names, links and icons. Which apps a site lists, and
 * whether it lists any, is a packaging decision of that site, not something
 * the component or a shared library hard-codes. Two files beside the site's
 * routes directory (`html/` for `html/routes`) decide it:
 *
 * - `app-switcher.json` — the data model: an optional `label` (the chevron's
 *   accessible name), the `apps` in grid order, each with an `id`, a `name`,
 *   an `http(s)` `href` and either an `icon` (an `.svg` file, relative to the
 *   manifest and inside its directory) or an `svg` (the icon's markup
 *   inline, so a generated manifest is one self-contained file); an optional
 *   `footer` (`{ href, label, detail? }`, an `http(s)` link the switcher
 *   renders under its apps) and optional `tokens` (`{ light?, dark? }`, each
 *   a map from a token name such as `sheet` to its value, which the host
 *   applies as `--brand-app-switcher-<name>` for the variant on screen).
 *   A site may check it in or copy it from a shared preset (tento's Lona
 *   preset is `tento-brand-lona-js/family/lona-switcher.json`).
 * - `.env` (the packager's own, gitignored, never checked in) — the switch:
 *   `TENTO_APP_SWITCHER=on` bundles the apps' links and icons; `off` bundles
 *   none of them. The process environment's `TENTO_APP_SWITCHER` overrides
 *   the file. With neither, the switcher is off, so a fresh clone of a site
 *   builds without it; only a host that opts in gets the switcher.
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
 * - a manifest and the switch on: `{ label, apps, footer, tokens }` (`null`
 *   for an absent footer or tokens), with every icon file imported as text
 *   through the SVG loader, so the manifest and icons are inputs of the
 *   build like any other source file; inline `svg` icons are bundled as
 *   they are.
 *
 * A malformed manifest, an unknown switch value or a missing icon fails the
 * build with a message naming the file. The env file is read here, not
 * through `@std/dotenv/load`, because that loads the bundler worker's own
 * directory, not the site's. Both files live in the HTML root, which
 * tento-web's bundle-reuse stamp walks whole, so a build after either changes
 * (or appears) rebuilds; the env variable is in the stamp's `ENV_NAMES`. The
 * dev watcher rebuilds only on the bundle's own inputs, so an edit to these
 * files during `serve` takes effect at the next rebuild or restart. The
 * per-file (`?fe=unbundled`) emitter does not run plugins and serves the
 * on-disk `undefined`.
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
export const APP_SWITCHER_ENV_FILE = ".env";

/** One app as the manifest declares it: exactly one of `icon` and `svg`. */
export type ManifestApp =
  & { readonly id: string; readonly name: string; readonly href: string }
  & (
    /** An `.svg` file, relative to the manifest. */
    | { readonly icon: string; readonly svg?: undefined }
    /** The icon's SVG markup, inline. */
    | { readonly svg: string; readonly icon?: undefined }
  );

/** The footer link under the apps. */
export interface ManifestFooter {
  readonly href: string;
  readonly label: string;
  readonly detail?: string;
}

/** Token values by name (`sheet`, `hover`, ...), per variant. */
export interface ManifestTokens {
  readonly light?: Readonly<Record<string, string>>;
  readonly dark?: Readonly<Record<string, string>>;
}

export interface Manifest {
  readonly label?: string;
  readonly apps: readonly ManifestApp[];
  readonly footer?: ManifestFooter;
  readonly tokens?: ManifestTokens;
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
  /** Per app: the import binding of its icon file, or its inline markup as a literal. */
  const iconExprs: string[] = [];
  for (const app of manifest.apps) {
    if (app.icon == null) {
      iconExprs.push(JSON.stringify(app.svg));
      continue;
    }
    const at = `${manifestPath}: app ${JSON.stringify(app.id)}: icon ${JSON.stringify(app.icon)}`;
    const outside = (dir: string, path: string): boolean => {
      const inside = relative(dir, path);
      return inside === ".." || inside.startsWith(`..${SEP}`) || isAbsolute(inside);
    };
    if (outside(configDir, resolve(configDir, app.icon))) throw new Error(`${at} is outside ${configDir}`);
    let icon: string;
    try {
      icon = await Deno.realPath(resolve(configDir, app.icon));
      if (!(await Deno.stat(icon)).isFile) throw new Deno.errors.NotFound(icon);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new Error(`${at} does not exist`);
      throw error;
    }
    // Real paths too, so a symlink cannot inline a file from outside the site.
    if (outside(await Deno.realPath(configDir), icon)) throw new Error(`${at} is outside ${configDir}`);
    iconExprs.push(`icon${icons.length} as string`);
    icons.push(icon);
  }
  const imports = icons.map((icon, i) => `import icon${i} from ${JSON.stringify(icon)};`);
  const apps = manifest.apps.map((app, i) =>
    `  Object.freeze({ id: ${JSON.stringify(app.id)}, name: ${JSON.stringify(app.name)}, href: ${
      JSON.stringify(app.href)
    }, icon: ${iconExprs[i]} }),`
  );
  const frozen = (record: Readonly<Record<string, string>> | undefined): string =>
    record == null ? "undefined" : `Object.freeze(${JSON.stringify(record)})`;
  const footer = manifest.footer == null ? "null" : frozen({ ...manifest.footer });
  const tokens = manifest.tokens == null
    ? "null"
    : `Object.freeze({ light: ${frozen(manifest.tokens.light)}, dark: ${frozen(manifest.tokens.dark)} })`;
  const contents = [
    `// Packaged by AppSwitcherPlugin from ${APP_SWITCHER_MANIFEST}: ${APP_SWITCHER_ENV}=on.`,
    ...imports,
    `export const PACKAGED_APP_SWITCHER = Object.freeze({`,
    `  label: ${JSON.stringify(manifest.label ?? null)},`,
    `  apps: Object.freeze([`,
    ...apps.map((line) => `  ${line}`),
    `  ]),`,
    `  footer: ${footer},`,
    `  tokens: ${tokens},`,
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

/**
 * Validates the manifest's shape: unique ids, non-empty names, `http(s)`
 * links, `.svg` icon files or inline `<svg>` markup, a well-formed footer and
 * tokens whose names are lowercase words joined by dashes.
 */
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
    if (!["label", "apps", "footer", "tokens", "$comment"].includes(key)) fail(`unknown key ${JSON.stringify(key)}`);
  }
  if (record.label != null && (typeof record.label !== "string" || record.label.trim() === "")) {
    fail("label must be a non-empty string");
  }
  if (!Array.isArray(record.apps)) fail("apps must be an array");
  const object = (v: unknown, at: string): Record<string, unknown> => {
    if (typeof v !== "object" || v == null || Array.isArray(v)) fail(`${at}: expected an object`);
    return v as Record<string, unknown>;
  };
  const onlyKeys = (o: Record<string, unknown>, keys: readonly string[], at: string): void => {
    for (const key of Object.keys(o)) {
      if (!keys.includes(key)) fail(`${at}: unknown key ${JSON.stringify(key)}`);
    }
  };
  const nonEmpty = (o: Record<string, unknown>, key: string, at: string): string => {
    if (typeof o[key] !== "string" || (o[key] as string).trim() === "") {
      fail(`${at}: ${key} must be a non-empty string`);
    }
    return o[key] as string;
  };
  const httpLink = (href: string, at: string): void => {
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      // reported below
    }
    if (url == null || (url.protocol !== "https:" && url.protocol !== "http:")) {
      fail(`${at}: href ${JSON.stringify(href)} must be an absolute http(s) URL`);
    }
  };
  const ids = new Set<string>();
  const apps = (record.apps as unknown[]).map((entry, i): ManifestApp => {
    const at = `apps[${i}]`;
    const app = object(entry, at);
    onlyKeys(app, ["id", "name", "href", "icon", "svg"], at);
    const id = nonEmpty(app, "id", at);
    const name = nonEmpty(app, "name", at);
    const href = nonEmpty(app, "href", at);
    if (ids.has(id)) fail(`${at}: duplicate id ${JSON.stringify(id)}`);
    ids.add(id);
    httpLink(href, at);
    if ((app.icon == null) === (app.svg == null)) fail(`${at}: expected exactly one of icon and svg`);
    if (app.svg != null) {
      const svg = nonEmpty(app, "svg", at);
      const trimmed = svg.trim();
      if (!/^<svg[\s>]/.test(trimmed) || !trimmed.endsWith("</svg>")) {
        fail(`${at}: svg must be one <svg>...</svg> element`);
      }
      return { id, name, href, svg };
    }
    const icon = nonEmpty(app, "icon", at);
    // Lowercase only: the SVG loader matches `.svg` exactly.
    if (!icon.endsWith(".svg")) fail(`${at}: icon ${JSON.stringify(icon)} must be an .svg file`);
    return { id, name, href, icon };
  });
  let footer: ManifestFooter | undefined;
  if (record.footer != null) {
    const f = object(record.footer, "footer");
    onlyKeys(f, ["href", "label", "detail"], "footer");
    const href = nonEmpty(f, "href", "footer");
    httpLink(href, "footer");
    const label = nonEmpty(f, "label", "footer");
    footer = f.detail != null ? { href, label, detail: nonEmpty(f, "detail", "footer") } : { href, label };
  }
  let tokens: ManifestTokens | undefined;
  if (record.tokens != null) {
    const t = object(record.tokens, "tokens");
    onlyKeys(t, ["light", "dark"], "tokens");
    const variant = (name: "light" | "dark"): Record<string, string> | undefined => {
      if (t[name] == null) return undefined;
      const at = `tokens.${name}`;
      const v = object(t[name], at);
      const out: Record<string, string> = {};
      for (const key of Object.keys(v)) {
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(key)) {
          fail(`${at}: token name ${JSON.stringify(key)} must be lowercase words joined by dashes`);
        }
        const value = nonEmpty(v, key, at);
        // A value is one declaration's value: it cannot end the declaration or the rule.
        if (/[;{}]/.test(value)) fail(`${at}: ${key} must not contain ; { or }`);
        out[key] = value;
      }
      return out;
    };
    const light = variant("light");
    const dark = variant("dark");
    tokens = { ...(light != null ? { light } : {}), ...(dark != null ? { dark } : {}) };
  }
  return {
    ...(record.label != null ? { label: record.label as string } : {}),
    apps,
    ...(footer != null ? { footer } : {}),
    ...(tokens != null ? { tokens } : {}),
  };
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
    // No --allow-env: only the site's .env decides.
    return undefined;
  }
}
