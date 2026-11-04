import { dirname, join, resolve } from "jsr:@std/path";

// Every module in an app must use its frontend's aliases. Allowing a dependency
// package's own tsconfig to select aliases can load a second component SDK in
// the same document, even though the app's TypeScript check passes.
export function frontendTsconfig(routesPath: string): { tsconfig?: string } {
  // The bundled RPC receives the route directory; the per-file caller receives
  // its containing HTML root. Both must select the same frontend config.
  const root = resolve(routesPath);
  for (const tsconfig of [join(root, "tsconfig.json"), join(dirname(root), "tsconfig.json")]) {
    try {
      if (Deno.statSync(tsconfig).isFile) return { tsconfig };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return {};
}
