import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";

import { build } from "./bundler.deno.ts";

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
