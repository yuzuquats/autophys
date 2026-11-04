import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

import { expandGlob } from "jsr:@std/fs";
import { CssMinifyPlugin } from "./css-minify.deno.ts";
import { SvgLoaderPlugin } from "./svg-loader.deno.ts";

import "jsr:@std/dotenv/load";

async function build({
  routesPath,
  outdir,
  minifyCss,
}: {
  routesPath: string;
  outdir: string;
  minifyCss: boolean;
}) {
  // console.log("Building", {routesPath, outdir});

  const entryPoints = (
    await Array.fromAsync(expandGlob(`${routesPath}/**/*.root.ts`))
  ).map((p) => p.path);

  if (entryPoints.length === 0) {
    return;
  }

  const plugins: esbuild.Plugin[] = [];
  plugins.push(new SvgLoaderPlugin());
  if (minifyCss) {
    plugins.push(new CssMinifyPlugin());
  }

  const result = await esbuild
    .build({
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
      console.log("Panic", e);
      return null;
    });
  // esbuild threw; the panic is already logged. Reading `.errors` off the
  // null was a TypeError, not a diagnostic.
  if (result == null) return;

  if (result.errors.length > 0) {
    console.log("Build errors", result.errors);
    return;
  }
}

const outdir = Deno.env.get("OUTDIR");
if (!outdir) Deno.exit();

const routesPath = Deno.env.get("ROUTES_PATH");
if (!routesPath) Deno.exit();

await build({
  routesPath,
  outdir,
  // @note:
  //    w/o minify: 3.24s, 92.8kb
  //    w   minify: 6.22s, 91.2kb
  minifyCss: false,
});

esbuild.stop();
