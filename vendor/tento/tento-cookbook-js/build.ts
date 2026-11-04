// Bundles one cookbook root (a *.root.ts that calls Cookbook.mount().run(app)) into a
// static tree a server can serve:
//
//   <out>/index.html       index.anon.html with the page title filled in
//   <out>/index.root.js    the bundle (+ .map)
//
//   deno run --allow-read --allow-write --allow-run --allow-env build.ts \
//     --root <file.root.ts> --out <dir> [--title <name>] [--config <deno.json>]
//
// The bundle is made by `deno bundle` (its built-in esbuild), with no lockfile
// writes, after `deno check` of the root.
const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) args.set(Deno.args[i], Deno.args[i + 1]);
const root = args.get("--root"), out = args.get("--out");
if (!root || !out) {
  throw new Error("usage: build.ts --root <file.root.ts> --out <dir> [--title <name>] [--config <deno.json>]");
}
const title = args.get("--title") ?? "Cookbook";
const config = args.get("--config");
const here = new URL(".", import.meta.url).pathname;

async function deno(...argv: string[]): Promise<void> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [argv[0], ...(config ? ["--config", config] : []), "--no-lock", ...argv.slice(1)],
  }).output();
  if (!result.success) {
    console.error(new TextDecoder().decode(result.stderr));
    Deno.exit(1);
  }
}

await Deno.remove(out, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(out, { recursive: true });
await deno("check", root);
await deno("bundle", "--platform", "browser", "--minify", "--sourcemap=linked", "-o", `${out}/index.root.js`, root);
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const shell = await Deno.readTextFile(`${here}index.anon.html`);
await Deno.writeTextFile(`${out}/index.html`, shell.replace("{{title}}", escape(title)));
const size = (Deno.statSync(`${out}/index.root.js`).size / 1024).toFixed(1);
console.log(`${out}: index.html (${title}), index.root.js ${size} KiB`);
