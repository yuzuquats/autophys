/**
 * tento-ui-js does not depend on the chat library.
 *
 * The chat renderer moved to `tento/tento-chat-js` (tento-chat-js plan,
 * revision 2). The dependency runs one way — `@tento-chat` imports the base
 * runtime and an allowlist of widgets — and this test keeps the base library
 * from reaching back: no file here may import `@tento-chat`, the old
 * `components/{chat,thread,turn,turn-term,turn-dsh,term,agent-thinking}/`
 * paths, or `session-replay`, which now lives in the chat package because it
 * hosts the chat's own `term-row`. No exemptions: the one-phase shims the
 * extraction left at the old paths are gone.
 */
import { assertEquals } from "jsr:@std/assert";

const ROOT = new URL(".", import.meta.url).pathname;
const FORBIDDEN = /from\s+["'](@tento-chat|[^"']*components\/(chat|thread|turn|turn-term|turn-dsh|term|agent-thinking)\/|[^"']*\/session-replay(-ansi)?(\.ts)?)["']|import\s+["'](@tento-chat|[^"']*components\/(chat|thread|turn|turn-term|turn-dsh|term|agent-thinking)\/|[^"']*\/session-replay(-ansi)?(\.ts)?)["']/;

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = dir + e.name;
    if (e.isDirectory) yield* walk(p + "/");
    else if (e.isFile && e.name.endsWith(".ts")) yield p;
  }
}

Deno.test("tento-ui-js never imports the chat library or its old paths", async () => {
  const offenders: string[] = [];
  for await (const file of walk(ROOT)) {
    const rel = file.slice(ROOT.length);
    if (rel === "import-boundary.deno.test.ts") continue;
    const src = await Deno.readTextFile(file);
    const m = FORBIDDEN.exec(src);
    if (m) offenders.push(`${rel} → ${m[0]}`);
  }
  assertEquals(offenders, [], "a tento-ui-js file reaches into the chat library; the dependency runs the other way");
});
