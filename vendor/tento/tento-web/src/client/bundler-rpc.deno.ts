import * as esbuild from "https://deno.land/x/esbuild@v0.24.0/mod.js";
import { resolve } from "jsr:@std/path";

import { RpcServer } from "../../../tento-core/src/subprocess/rpc-server.deno.ts";
import { getEsbuildContext, stop } from "./bundler.deno.ts";
import { emitPerFile } from "./bundler-perfile.deno.ts";
import { resolutionEvidence } from "./bundler-resolution.deno.ts";
import { frontendTsconfig } from "./frontend-tsconfig.deno.ts";

// The server dispatches requests without waiting for earlier ones, so this
// worker decides what may overlap. Two handlers for one key never do: two
// rebuilds of one routes dir would cancel each other's esbuild context, and two
// emits of one html root would race on its manifests. Different keys run
// concurrently, at most MAX_CONCURRENT at a time, which is also what bounds
// this process's memory: each build in flight holds its graph and outputs.
const MAX_CONCURRENT = 4;

// A busy worker answers pings late. The stock 5 s silence timeout made a long
// emit look like a dead parent; a parent that really is gone is still noticed
// at once, by EOF on stdin or a broken pipe on the next ping.
const SILENCE_TIMEOUT_SECONDS = 60;

const keyTails = new Map<string, Promise<void>>();
let running = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((wake) => waiting.push(wake));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

export function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = keyTails.get(key) ?? Promise.resolve();
  const result = previous.then(async () => {
    await acquire();
    try {
      return await work();
    } finally {
      release();
    }
  });
  const tail = result.then(() => {}, () => {});
  keyTails.set(key, tail);
  tail.then(() => {
    if (keyTails.get(key) === tail) keyTails.delete(key);
  });
  return result;
}

async function failureReason(e: unknown): Promise<string> {
  const failure = e as { errors?: esbuild.Message[] };
  return failure.errors?.length
    ? (await esbuild.formatMessages(failure.errors, { kind: "error" })).join("")
    : String(e);
}

// Metafile keys are relative to esbuild's working dir (this process's cwd);
// plugin-namespaced inputs (`ns:…`) are not files.
function metafileFiles(result: esbuild.BuildResult | undefined): string[] {
  const cwd = Deno.cwd();
  return Object.keys(result?.metafile?.inputs ?? {})
    .filter((p) => !/^[a-z-]+:/.test(p))
    .map((p) => resolve(cwd, p));
}

// Handler function for bundling TypeScript files
function handleBuild(params: {
  routesPath: string;
  outdir: string;
}): Promise<Record<string, unknown>> {
  return exclusive(`build:${params.routesPath}`, () => build(params));
}

async function build(params: {
  routesPath: string;
  outdir: string;
}): Promise<Record<string, unknown>> {
  try {
    const routesPath = params.routesPath;
    const outdir = params.outdir;

    if (!routesPath || !outdir) {
      return {
        status: "error",
        errorReason: "Missing required parameters: routesPath and outdir",
      };
    }

    const esbuildContext = await getEsbuildContext({
      routesPath,
      outdir,
    });

    await esbuildContext.cancel();
    const result = await esbuildContext.rebuild();

    // esbuild's context `rebuild()` usually THROWS a BuildFailure on error
    // (handled in `catch`), but for a multi-entrypoint build it can also RESOLVE
    // with a result whose `errors` array is populated. Handle both: inspect the
    // resolved result here, and the thrown failure below.
    const errors = (result?.errors ?? []) as esbuild.Message[];
    if (errors.length > 0) {
      const reason = (await esbuild.formatMessages(errors, { kind: "error" }))
        .join("");
      return {
        status: "error",
        errorReason: reason,
      };
    }

    // Every source file this pass read, absolute: `inputs` excludes vendor
    // modules (the server derives its dev watch set from it), `allInputs` keeps
    // them (the reuse stamp hashes everything the bundle was built from).
    const allInputs = metafileFiles(result);
    const inputs = allInputs.filter((p) => !p.includes("/node_modules/"));
    // What the resolver consulted besides the files it read: the stamp
    // records it, the dev watcher watches it.
    const resolution = resolutionEvidence(
      result?.metafile,
      Deno.cwd(),
      frontendTsconfig(routesPath).tsconfig,
    );
    return {
      status: "ok",
      inputs,
      allInputs,
      resolution,
    };
  } catch (e) {
    // Defensive: if `rebuild()` ever rejects (e.g. a thrown BuildFailure or a
    // cancel), format its structured `errors` the same way.
    return {
      status: "error",
      errorReason: await failureReason(e),
    };
  }
}

// The per-file ("unbundled") emit, run here rather than in a fresh `deno run`
// per build: this process already has Deno, the module graph of the build
// scripts and the esbuild service warm. Any failure is returned as data with
// its diagnostics; the Rust side reports it.
function handlePerfile(params: {
  routesPath: string;
  store: string;
  betaDir?: string;
}): Promise<Record<string, unknown>> {
  return exclusive(`perfile:${params.routesPath}`, async () => {
    if (!params.routesPath || !params.store) {
      return {
        status: "error",
        errorReason: "Missing required parameters: routesPath and store",
      };
    }
    try {
      const result = await emitPerFile({
        routesPath: params.routesPath,
        store: params.store,
        betaDir: params.betaDir,
        log: (line) => console.error(line),
      });
      return {
        status: "ok",
        modules: result.modules,
        roots: result.roots.length,
        injected: result.injected,
        skipped: result.skipped,
        storeFiles: result.storeFiles,
        inputs: result.inputs,
        resolution: result.resolution,
      };
    } catch (e) {
      return { status: "error", errorReason: await failureReason(e) };
    }
  });
}

// Create and start the RPC server
if (import.meta.main) {
  const server = new RpcServer(undefined, 10, SILENCE_TIMEOUT_SECONDS);
  server.registerHandler("build", handleBuild);
  server.registerHandler("perfile", handlePerfile);
  // Test seam, off unless the test harness sets it: lets the Rust tests make
  // the worker die mid-call and observe the replacement.
  if (Deno.env.get("TENTO_BUNDLER_RPC_TEST_SEAMS") === "1") {
    server.registerHandler("exit", (params: { code?: number }) => {
      Deno.exit(params.code ?? 1);
    });
    server.registerHandler("sleep", async (params: { ms: number }) => {
      await new Promise((wake) => setTimeout(wake, params.ms));
      return { status: "ok" };
    });
  }
  server.registerDropHandler(stop);
  await server.run();
  Deno.exit(0);
}
