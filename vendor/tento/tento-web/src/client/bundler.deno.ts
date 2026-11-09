import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

import { expandGlob } from "jsr:@std/fs";
import { AppSwitcherPlugin } from "../../../tento-web-js/build-plugins/app-switcher.deno.ts";
import { BuildStampPlugin } from "../../../tento-web-js/build-plugins/build-stamp.deno.ts";
import { CssMinifyPlugin } from "../../../tento-web-js/build-plugins/css-minify.deno.ts";
import { SvgLoaderPlugin } from "../../../tento-web-js/build-plugins/svg-loader.deno.ts";
import { frontendTsconfig } from "./frontend-tsconfig.deno.ts";

import "jsr:@std/dotenv/load";

export type RoutesPath = string;
// deno-lint-ignore no-explicit-any
export type EsbuildContext = any;

const CACHED_CONTEXT: Map<
  RoutesPath,
  {
    context: EsbuildContext;
    outdir: string;
    entryPoints: Set<string>;
    tsconfig: string | undefined;
  }
> = new Map();

export async function getEsbuildContext({
  routesPath,
  outdir,
}: {
  routesPath: RoutesPath;
  outdir: string;
}): Promise<EsbuildContext> {
  const entryPoints = new Set(
    (await Array.fromAsync(expandGlob(`${routesPath}/**/*.root.ts`))).map(
      (p) => p.path,
    ),
  );

  // The tsconfig is fixed when a context is created, so a tsconfig.json that
  // appeared (or went) since must make a new one: a reused context would
  // keep resolving through the old aliases, unlike a fresh worker.
  const { tsconfig } = frontendTsconfig(routesPath);
  const existing = CACHED_CONTEXT.get(routesPath);
  if (existing) {
    if (
      setsEqual(existing.entryPoints, entryPoints) &&
      existing.outdir === outdir &&
      existing.tsconfig === tsconfig
    ) {
      return existing.context;
    }
    await existing.context.dispose();
  }

  const context = await esbuild.context({
    ...(tsconfig ? { tsconfig } : {}),
    entryPoints: [...entryPoints],
    outdir,
    outbase: routesPath,
    bundle: true,
    treeShaking: true,
    format: "esm",
    minify: true,
    sourcemap: "linked",
    // The inputs list is the dev watcher's watch set — see bundler-rpc.
    metafile: true,
    plugins: [new SvgLoaderPlugin(), new BuildStampPlugin(), new AppSwitcherPlugin(routesPath)],
  });
  CACHED_CONTEXT.set(routesPath, {
    context,
    outdir,
    entryPoints,
    tsconfig,
  });
  return context;
}

export async function build({
  routesPath,
  outdir,
  minifyCss,
}: {
  routesPath: RoutesPath;
  outdir: string;
  minifyCss: boolean;
}) {
  console.error("Building", { routesPath, outdir });

  const entryPoints = (
    await Array.fromAsync(expandGlob(`${routesPath}/**/*.root.ts`))
  ).map((p) => p.path);

  if (entryPoints.length === 0) return;

  const plugins: esbuild.Plugin[] = [];
  plugins.push(new SvgLoaderPlugin());
  plugins.push(new BuildStampPlugin());
  plugins.push(new AppSwitcherPlugin(routesPath));
  if (minifyCss) {
    plugins.push(new CssMinifyPlugin());
  }

  const result = await esbuild
    .build({
      ...frontendTsconfig(routesPath),
      entryPoints,
      outdir,
      outbase: routesPath,
      bundle: true,
      treeShaking: true,
      format: "esm",
      minify: true,
      sourcemap: "linked",
      plugins,
    })
    .catch((e) => {
      console.error("Panic", e);
      return null;
    });
  // esbuild threw; the panic is already logged. Reading `.errors` off the
  // null was a TypeError, not a diagnostic.
  if (result == null) return;

  if (result.errors.length > 0) {
    console.error("Build errors", result.errors);
    return;
  }
}

function setsEqual(setA: Set<string>, setB: Set<string>): boolean {
  if (setA.size != setB.size) return false;

  for (const item of setA) {
    if (!setB.has(item)) return false;
  }

  return true;
}

export async function stop() {
  for (const { context } of CACHED_CONTEXT.values()) {
    await context.dispose();
  }
  console.error("finished canceling all contexts");
  await esbuild.stop();
  console.error("stopped esbuild");
}
