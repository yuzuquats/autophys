import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

import { dirname } from "jsr:@std/path";

const decoder = new TextDecoder("utf-8");

/**
 * Replaces any bundled `build-stamp.ts` module with a freshly generated
 * `export const BUILD_STAMP = "<git-short>@<iso-seconds>";` on every esbuild
 * pass, so a served bundle self-identifies its build in runtime breadcrumbs
 * (the app's `app/build` trail entry) with no hand-bumped literal.
 *
 * Why an onLoad plugin and not `define`/`banner`: the watch loop reuses one
 * esbuild context across rebuilds (bundler.deno.ts CACHED_CONTEXT), and
 * `define`/`banner` are frozen at context creation. `onLoad` re-runs on every
 * `context.rebuild()` even when the file on disk is unchanged (verified
 * empirically on esbuild v0.24.0), which is exactly the per-build hook needed.
 *
 * Contract: a module whose path ends in `build-stamp.ts` is replaced
 * wholesale, so it MUST export exactly one const, `BUILD_STAMP`, and its
 * on-disk contents are a dev/test placeholder. The per-file (`?fe=unbundled`)
 * emitter deliberately does NOT stamp: a per-build value would mint a new
 * content-addressed module into the shared store on every rebuild.
 */
export class BuildStampPlugin implements esbuild.Plugin {
  name: string = "build-stamp";

  setup(build: esbuild.PluginBuild) {
    build.onLoad(
      { filter: /[/\\]build-stamp\.ts$/ },
      async (args: esbuild.OnLoadArgs) => {
        const hash = await sourceShortHead(args.path, buildGitHashEnv());
        const builtAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        return {
          contents: `export const BUILD_STAMP = "${hash}@${builtAt}";\n`,
          loader: "ts",
        };
      },
    );
  }
}

/** The commit a packager names for a build from a `git archive`, which has no
 * `.git` to ask. tento-web's `build-version.json` (bundler.rs
 * `BUILD_GIT_HASH_ENV`) reads the same variable. */
export const BUILD_GIT_HASH_ENV = "TENTO_BUILD_GIT_HASH";

function buildGitHashEnv(): string | undefined {
  try {
    return Deno.env.get(BUILD_GIT_HASH_ENV);
  } catch {
    // No --allow-env: the build simply has no explicit commit.
    return undefined;
  }
}

/** Short hash of the commit `file` was built from; "nogit" when that is not
 * known (e.g. a deployed host building from a packaged app outside any
 * checkout).
 *
 * `explicit` (from `TENTO_BUILD_GIT_HASH`) wins when it is 7 to 40 lowercase
 * hex digits; anything else is refused rather than spliced into the bundle.
 * Otherwise git is asked, and its answer counts only when the repository it
 * finds tracks `file`. `git rev-parse` walks up past an untracked directory to
 * whatever checkout encloses it: the campaign RC's Lona bundles, built from a
 * `git archive` extracted in an ignored scratch directory under rwc-dev-01's
 * `~/workspace`, carried that workspace's HEAD `e8bbb29`. */
export async function sourceShortHead(
  file: string,
  explicit: string | undefined,
): Promise<string> {
  const named = explicit?.trim();
  if (named) return /^[0-9a-f]{7,40}$/.test(named) ? named : "nogit";
  const dir = dirname(file);
  if ((await git(dir, ["ls-files", "--error-unmatch", "--", file])) === null) {
    return "nogit";
  }
  const hash = await git(dir, ["rev-parse", "--short", "HEAD"]);
  return hash ? hash : "nogit";
}

/** stdout of a successful git command in `cwd`, else null. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const out = await new Deno.Command("git", {
      args,
      cwd,
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.success ? decoder.decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}
