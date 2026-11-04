// The charter's shared parsing — one source of truth for the lint
// (`check-charter.deno.ts`) and the generator (`gen-charter.deno.ts`), so the
// two can never disagree about what a registration, an admission, or a
// story's tag list is.
import { StdCharter } from "../std-charter.ts";

export const ROOT = new URL("../../", import.meta.url).pathname; // the tento repo root
export const ALLOWLIST = `${ROOT}tento-ui-js/std-charter.allowlist`;
export const LEGACY = `${ROOT}tento-ui-js/std-charter.legacy`;
export const UI = `${ROOT}tento-ui-js`;

const SKIP = new Set([
  "node_modules", ".git", "target", "__releases", ".review-harness", ".review-media",
]);

// Lazy, so it can never span two decorators — a greedy `[^}]*` matches from one
// `@component` to the closing brace of a LATER one and inflates every count.
const DECORATOR = /@component\s*\(\s*\{(.*?)\}\s*\)/gs;
const NAME = /name:\s*"([a-z0-9-]+)"/;

// A storybook's tag list is read from SOURCE, not by loading the module: the
// scripts run under deno, the examples import the DOM. Literal arrays only —
// the same trade-off the decorator regex makes. A computed body does not
// match, and the lint reports the story as declaring nothing.
const CLASS = /export class (\w+StoryBook)\b/g;
const TAGS = /tags\(\)\s*:\s*string\[\]\s*\{\s*return\s*\[([^\]]*)\]\s*;?\s*\}/;

export type Registration = { tag: string; file: string; line: number };
export type Admission = { tag: string; category: Option<string>; line: number };
/** One storybook class that declares tags. `example` is repo-relative, the
 * form a `<std-storybook-card example=…>` takes. */
export type Story = { className: string; tags: string[]; example: string; line: number };

/** Paths git tracks, or null when git cannot answer (a standalone export).
 *
 * SKIP names review-artifact directories one at a time, which works until
 * someone adds another: `review-master-rendering-20260908/source-before/`
 * carries a whole second copy of the commit-review tree, and every class in it
 * registered as a duplicate — five findings about a directory that is not in
 * the repository at all. Naming the known producers cannot catch the next one,
 * so ask git what is real instead. A file you have created but not yet added
 * is invisible here; `git add -N` makes it visible, the same rule
 * ts.check.coverage follows. */
let trackedCache: Set<string> | null | undefined = undefined;
async function tracked(): Promise<Set<string> | null> {
  if (trackedCache !== undefined) return trackedCache;
  try {
    const out = await new Deno.Command("git", {
      args: ["-C", ROOT, "ls-files"],
      stdout: "piped",
      stderr: "null",
    }).output();
    trackedCache = out.success
      ? new Set(
        new TextDecoder().decode(out.stdout).split("\n").filter(Boolean)
          .map((rel) => `${ROOT}${rel}`),
      )
      : null;
  } catch {
    trackedCache = null; // no git binary, or not a checkout
  }
  return trackedCache;
}

export async function* walk(dir: string): AsyncGenerator<string> {
  const only = await tracked();
  for await (const entry of Deno.readDir(dir)) {
    if (SKIP.has(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (
      entry.name.endsWith(".ts") && !entry.name.endsWith(".deno.test.ts") &&
      (only == null || only.has(path))
    ) yield path;
  }
}

async function readOrSkip(path: string): Promise<Option<string>> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null; // a broken symlink in a build artifact tree
  }
}

export async function registrations(): Promise<Registration[]> {
  const found: Registration[] = [];
  for await (const path of walk(ROOT.replace(/\/$/, ""))) {
    const source = await readOrSkip(path);
    if (source == null) continue;
    for (const match of source.matchAll(DECORATOR)) {
      const name = NAME.exec(match[1]);
      if (!name) continue;
      const line = source.slice(0, match.index).split("\n").length;
      found.push({ tag: name[1], file: path.slice(ROOT.length), line });
    }
  }
  return found;
}

// `tag<TAB>category<TAB># source` for std- lines; `tag<TAB># note` for vendor
// exceptions; the legacy file has no category column at all. Whitespace before
// a `#` is the end of the columns.
export function admissions(text: string): Admission[] {
  const rows: Admission[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const cols = line.split("#")[0].trim().split(/[\t ]+/);
    rows.push({ tag: cols[0], category: cols[1] ?? null, line: i + 1 });
  });
  return rows;
}

export function allowed(rows: Admission[]): Set<string> {
  return new Set(rows.map((r) => r.tag));
}

export function categoryOf(rows: Admission[]): Map<string, StdCharter.Category> {
  const m = new Map<string, StdCharter.Category>();
  for (const r of rows) {
    if (r.category != null && StdCharter.isCategory(r.category)) m.set(r.tag, r.category);
  }
  return m;
}

/** Inspect declarations, rather than treating every example-named helper or
 * compatibility re-export as a separately renderable catalogue card. */
export function inspectStorySource(example: string, source: string): { examples: string[]; stories: Story[] } {
  const found: Story[] = [];
  const classes = [...source.matchAll(CLASS)];
  classes.forEach((m, i) => {
    const body = source.slice(m.index, classes[i + 1]?.index ?? source.length);
    const t = TAGS.exec(body);
    if (!t) return;
    const tags = t[1].split(",").map((s) => s.trim()).filter((s) => s !== "");
    // `return []` is an extension story spelling out the default; it claims
    // nothing and is not a core card.
    if (tags.length === 0) return;
    const literal = tags.every((s) => /^"std-[a-z0-9-]+"$/.test(s));
    if (!literal) return;
    const line = source.slice(0, m.index).split("\n").length;
    found.push({
    className: m[1],
    tags: tags.map((s) => s.slice(1, -1)),
    example,
    line,
    });
  });
  return { examples: classes.length > 0 ? [example] : [], stories: found };
}

/** Story-declaring example files and the literal core-tag declarations in them.
 * Untagged classes remain extension candidates; helpers and re-exports add no card. */
export async function stories(): Promise<{ examples: string[]; stories: Story[] }> {
  const examples: string[] = [];
  const found: Story[] = [];
  for await (const path of walk(UI)) {
    if (!path.endsWith(".example.ts")) continue;
    const source = await readOrSkip(path);
    if (source == null) continue;
    const inspected = inspectStorySource(path.slice(ROOT.length), source);
    examples.push(...inspected.examples);
    found.push(...inspected.stories);
  }
  examples.sort();
  found.sort((a, b) => a.example.localeCompare(b.example) || a.line - b.line);
  return { examples, stories: found };
}
