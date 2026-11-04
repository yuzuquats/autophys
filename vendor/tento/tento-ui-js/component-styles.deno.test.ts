import { assertEquals } from "jsr:@std/assert";

/**
 * `css` refuses an interpolation (judge r14, R14-N3).
 *
 * Type-checks `component-styles.types.ts` with the workspace config (the
 * suite itself runs under `--no-check`): its `@ts-expect-error` line, a `${}`
 * inside ``css`…` ``, must not compile, and its plain forms must. Only
 * diagnostics in the types file and in `component-styles.ts` count; the check
 * also reports errors elsewhere in the workspace that this guard does not own.
 */

const TYPES = new URL("./component-styles.types.ts", import.meta.url).pathname;
const STYLES = new URL("./component-styles.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

/** `TSxxxx [ERROR]: message … at file:///path:line:col`, colour-free. */
const DIAGNOSTIC = /(TS\d+) \[ERROR\]: ([^\n]*)\n[\s\S]*?\n\s+at (file:\/\/[^\s]+?):(\d+):\d+/g;

Deno.test("css tag: an interpolation does not type-check; a plain template and a built string do", async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--quiet", "--config", CONFIG, TYPES],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
  // A parse or resolution failure aborts the check (`error: …`); a type error ends it with "Type checking failed".
  const aborted = text.split("\n").filter((line) => line.startsWith("error: ") && line !== "error: Type checking failed.");
  assertEquals(aborted, [], `the check did not run to completion:\n${text}`);
  const mine = [...text.matchAll(DIAGNOSTIC)]
    .filter((m) => [TYPES, STYLES].includes(new URL(m[3]).pathname))
    .map((m) => `${new URL(m[3]).pathname.split("/").pop()}:${m[4]} ${m[1]} ${m[2]}`);
  assertEquals(mine, [], text);
});
