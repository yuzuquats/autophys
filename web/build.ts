// Builds the client into web/dist/ (ignored): index.html, style.css and one
// ES module bundle made by `deno bundle`. Run with `deno task build`.
const root = new URL(".", import.meta.url).pathname;
const dist = `${root}dist`;
await Deno.remove(dist, { recursive: true }).catch((error) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(dist, { recursive: true });

const check = await new Deno.Command(Deno.execPath(), { args: ["check", `${root}src/main.ts`], cwd: root })
  .output();
if (!check.success) {
  console.error(new TextDecoder().decode(check.stderr));
  Deno.exit(1);
}
const bundle = await new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform",
    "browser",
    "--minify",
    "--sourcemap=linked",
    "-o",
    `${dist}/main.js`,
    `${root}src/main.ts`,
  ],
  cwd: root,
}).output();
if (!bundle.success) {
  console.error(new TextDecoder().decode(bundle.stderr));
  Deno.exit(1);
}
await Deno.copyFile(`${root}index.html`, `${dist}/index.html`);
await Deno.copyFile(`${root}src/style.css`, `${dist}/style.css`);
const size = (path: string) => `${(Deno.statSync(path).size / 1024).toFixed(1)} KiB`;
console.log(
  `web/dist: main.js ${size(`${dist}/main.js`)}, style.css ${size(`${dist}/style.css`)}, index.html`,
);
