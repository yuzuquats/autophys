// Structural UI charter checks. tento-rebar owns discovery, policy and reports;
// this module supplies the TypeScript-specific inspection. The catalogue app
// opts in separately with an explicit path; no sibling Lona checkout is assumed.
import { StdCharter } from "../std-charter.ts";
import {
  type Admission,
  admissions,
  allowed,
  ALLOWLIST,
  categoryOf,
  LEGACY,
  type Registration,
  registrations,
  stories,
  type Story,
} from "./charter-lib.deno.ts";
import { generate, OUTPUT } from "./gen-charter.deno.ts";

export type Violation = { message: string; severity: "error" | "warn" };
export type CharterInput = {
  found: Registration[];
  listRows: Admission[];
  legacyRows: Admission[];
  cards: Story[];
  expected: string;
  onDisk: string | null;
};

export function checkComponents(
  input: CharterInput,
  strict = false,
): Violation[] {
  const { found, listRows, legacyRows, cards, expected, onDisk } = input;
  const list = allowed(listRows);
  const legacy = allowed(legacyRows);
  const category = categoryOf(listRows);
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const row of listRows) {
    const isStd = row.tag.startsWith("std-");
    if (
      isStd && (row.category == null || !StdCharter.isCategory(row.category))
    ) {
      failures.push(
        `\`${row.tag}\` has no valid category (std-charter.allowlist:${row.line}` +
          `${row.category == null ? "" : `, got \`${row.category}\``}) — ` +
          `one of: ${StdCharter.CATEGORIES.map((c) => c.id).join(", ")}`,
      );
    }
    if (!isStd && row.category != null) {
      failures.push(
        `\`${row.tag}\` is a vendor exception and carries a category ` +
          `(std-charter.allowlist:${row.line}) — only std- lines are placed`,
      );
    }
  }

  const byTag = new Map<string, Registration[]>();
  for (const r of found) {
    const seen = byTag.get(r.tag);
    if (seen) seen.push(r);
    else byTag.set(r.tag, [r]);
  }

  for (const [tag, where] of [...byTag].sort()) {
    if (where.length > 1) {
      failures.push(
        `duplicate registration \`${tag}\` — @component throws on the second, so ` +
          `any bundle importing both dies at load:\n` +
          where.map((w) => `      ${w.file}:${w.line}`).join("\n"),
      );
    }
    if (!tag.startsWith("std-") || list.has(tag) || legacy.has(tag)) continue;
    failures.push(
      `\`${tag}\` claims the std- prefix but is not in std-charter.allowlist\n` +
        `      ${where[0].file}:${where[0].line}\n` +
        `      Either give it a tier prefix (lona-, dev-, or its surface's own), ` +
        `or add it to the allowlist and say in the note why it qualifies.`,
    );
  }

  // Rules 4–6: the join between stories and the allowlist.
  const claimedBy = new Map<string, string[]>();
  for (const card of cards) {
    const where = `${card.example}:${card.line} (${card.className})`;
    const cats = new Set<string>();
    for (const tag of card.tags) {
      if (!list.has(tag)) {
        failures.push(
          `\`${tag}\` is declared by a story but is not on std-charter.allowlist\n` +
            `      ${where}\n` +
            `      A story cannot claim a tag into core; add the allowlist line first.`,
        );
      }
      const c = category.get(tag);
      if (c != null) cats.add(c);
      const seen = claimedBy.get(tag);
      if (seen) seen.push(where);
      else claimedBy.set(tag, [where]);
    }
    if (cats.size > 1) {
      failures.push(
        `\`${card.className}\` declares tags in ${cats.size} categories (${
          [...cats].join(", ")
        }) — ` +
          `a card is placed by its primary tag, so every tag on it must share one\n      ${where}`,
      );
    }
  }
  for (const [tag, where] of [...claimedBy].sort()) {
    if (where.length > 1) {
      failures.push(
        `\`${tag}\` is declared by ${where.length} stories — one card per tag:\n` +
          where.map((w) => `      ${w}`).join("\n"),
      );
    }
  }
  const uncovered = [...list].filter((t) =>
    t.startsWith("std-") && !claimedBy.has(t)
  ).sort();
  if (uncovered.length > 0) {
    (strict ? failures : warnings).push(
      `${uncovered.length} allowlisted tag(s) have no story declaring them — the catalogue ` +
        `shows each as a gap:\n` + uncovered.map((t) =>
          `      ${t}`
        ).join("\n"),
    );
  }

  // Rule 7: the committed module is what the generator would write.
  if (onDisk !== expected) {
    failures.push(
      `${"tento-ui-js/std-charter.gen.ts"} is ${
        onDisk == null ? "missing" : "stale"
      } — ` +
        `run \`deno run -A tento/tento-ui-js/scripts/gen-charter.deno.ts\` and commit the result`,
    );
  }

  return [
    ...failures.map((message): Violation => ({ message, severity: "error" })),
    ...warnings.map((message): Violation => ({ message, severity: "warn" })),
  ];
}

export async function inspectComponents(strict = false): Promise<Violation[]> {
  const found = await registrations();
  const listRows = admissions(await Deno.readTextFile(ALLOWLIST));
  const legacyRows = admissions(await Deno.readTextFile(LEGACY));
  const { stories: cards } = await stories();
  const expected = await generate();
  let onDisk: string | null = null;
  try {
    onDisk = await Deno.readTextFile(OUTPUT);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return checkComponents({
    found,
    listRows,
    legacyRows,
    cards,
    expected,
    onDisk,
  }, strict);
}

export function catalogueImports(source: string): Set<string> {
  const found = new Set<string>();
  for (
    const m of source.matchAll(
      /\b(?:from\s*|import\s*)["']@tento-ui\/([^"']+\.example)(?:\.ts)?["']/g,
    )
  ) {
    found.add(`tento-ui-js/${m[1]}.ts`);
  }
  return found;
}

export function checkCatalogue(
  { examples, stories: cards }: { examples: string[]; stories: Story[] },
  catalogue: string,
): Violation[] {
  const failures: string[] = [];
  const warnings: string[] = [];
  const imported = catalogueImports(catalogue);
  const generated = new Set(cards.map((c) => c.example));
  const orphans = examples.filter((e) => !imported.has(e) && !generated.has(e));
  if (orphans.length > 0) {
    warnings.push(
      `${orphans.length} example file(s) are imported by neither std-charter.gen.ts nor the catalogue — ` +
        `nobody can see the card:\n` + orphans.map((e) =>
          `      ${e}`
        ).join("\n"),
    );
  }
  const twice = cards.filter((c) => imported.has(c.example));
  for (const c of twice) {
    failures.push(
      `\`${c.className}\` declares tags AND is imported by the catalogue's examples.ts — ` +
        `a core card is placed by the generated module; remove the hand import\n      ${c.example}`,
    );
  }
  return [
    ...failures.map((message): Violation => ({ message, severity: "error" })),
    ...warnings.map((message): Violation => ({ message, severity: "warn" })),
  ];
}

if (import.meta.main) {
  console.error(
    "Use tento-rebar check tento-ui-js; this module is the checker implementation.",
  );
  Deno.exit(2);
}
