import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

import { dirname, join, resolve } from "jsr:@std/path";

import { parseEnvFile } from "./app-switcher.deno.ts";

/**
 * # Build switches: a module that is bundled only when its packager opts in
 *
 * Some of a site's content belongs to one deployment, not to its source: a
 * notice, a link or a badge that the hosted site shows and a clone of the
 * repository must not. `AppSwitcherPlugin` decides that for the app switcher;
 * this plugin is the same switch for any other module.
 *
 * A switched module's file name ends in `.switched.ts`, its first line names
 * its switch, and it has a single default export:
 *
 * ```ts
 * // build-switch: EXAMPLE_NOTICE
 * const notice: { readonly text: string } | null = { text: "..." };
 * export default notice;
 * ```
 *
 * The switch is read like `TENTO_APP_SWITCHER`: from the packager's own
 * gitignored `.env` beside the routes directory (`html/.env` for
 * `html/routes`), overridden by the process environment. With `on` (also `1`
 * or `true`) the module is bundled as written. Otherwise, including when
 * neither sets it, the module is replaced by `export default null;`, so none
 * of its text is in the bundle and a fresh clone builds without it. Callers
 * treat `null` as "not packaged".
 *
 * A switched module without the header, or a switch with any other value,
 * fails the build naming the file. Like the app switcher's, the `.env` lives
 * in the HTML root, which tento-web's bundle-reuse stamp walks whole, so
 * editing it rebuilds; a switch set only in the process environment is not
 * in the stamp's `ENV_NAMES`, so a reused bundle keeps its earlier answer.
 * The per-file (`?fe=unbundled`) emitter and Deno tests run no plugins and
 * see the module as written.
 */
export class BuildSwitchPlugin implements esbuild.Plugin {
  name: string = "build-switch";
  // A #private field: esbuild rejects a plugin object with own keys besides name and setup.
  readonly #configDir: string;

  /** `routesPath` is the routes directory being bundled; its parent holds the site's `.env`. */
  constructor(routesPath: string) {
    this.#configDir = dirname(resolve(routesPath));
  }

  // An arrow field: esbuild calls `setup` detached from the plugin object.
  setup = (build: esbuild.PluginBuild): void => {
    build.onLoad(
      { filter: /\.switched\.ts$/ },
      async (args: esbuild.OnLoadArgs): Promise<esbuild.OnLoadResult> => {
        const source = await Deno.readTextFile(args.path);
        const switched = await switchModule(this.#configDir, args.path, source, envSwitch);
        return { contents: switched.contents, loader: "ts", watchFiles: switched.watchFiles };
      },
    );
  };
}

export const BUILD_SWITCH_ENV_FILE = ".env";
const HEADER = /^\/\/ build-switch: ([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?$/;

/** The switch a switched module's first line names. */
export function switchName(source: string, path: string): string {
  const match = HEADER.exec(source.split("\n", 1)[0]);
  if (match == null) throw new Error(`${path}: a .switched.ts module must start with "// build-switch: NAME"`);
  return match[1];
}

/** `on` or `off` (also `1`/`0`, `true`/`false`, empty, case-insensitive); anything else fails the build. */
export function parseBuildSwitch(name: string, value: string, source: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true") return true;
  if (v === "off" || v === "0" || v === "false" || v === "") return false;
  throw new Error(`${source}: ${name}=${JSON.stringify(value)}; expected on or off`);
}

/**
 * The module to bundle for the switched module at `path` with text `source`,
 * for the site whose `.env` is in `configDir`. `processEnv` reads the process
 * environment (`undefined` when unset).
 */
export async function switchModule(
  configDir: string,
  path: string,
  source: string,
  processEnv: (name: string) => string | undefined,
): Promise<{ on: boolean; contents: string; watchFiles: string[] }> {
  const name = switchName(source, path);
  const envPath = join(configDir, BUILD_SWITCH_ENV_FILE);
  const fromProcess = processEnv(name);
  const fromFile = parseEnvFile(await readOptional(envPath) ?? "", envPath)[name];
  const on = parseBuildSwitch(name, fromProcess ?? fromFile ?? "off", fromProcess != null ? `$${name}` : envPath);
  const contents = on ? source : `// Switched off by BuildSwitchPlugin: ${name} is not on.\nexport default null;\n`;
  return { on, contents, watchFiles: [path, envPath] };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function envSwitch(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // No --allow-env: only the site's .env decides.
    return undefined;
  }
}
