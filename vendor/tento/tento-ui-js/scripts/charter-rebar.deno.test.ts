import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  type CharterInput,
  checkCatalogue,
  checkComponents,
} from "./check-charter.deno.ts";
import { run } from "./charter-rebar.deno.ts";
import { inspectStorySource } from "./charter-lib.deno.ts";

function valid(): CharterInput {
  return {
    found: [{ tag: "std-fixture", file: "component.ts", line: 1 }],
    listRows: [{ tag: "std-fixture", category: "action", line: 1 }],
    legacyRows: [],
    cards: [{
      className: "FixtureStoryBook",
      tags: ["std-fixture"],
      example: "tento-ui-js/fixture.example.ts",
      line: 1,
    }],
    expected: "generated",
    onDisk: "generated",
  };
}

Deno.test("the component rule retains admission, duplicate, category and story checks", () => {
  assertEquals(checkComponents(valid()), []);
  const changes: Array<[string, (input: CharterInput) => void]> = [
    ["claims the std- prefix", (x) => x.listRows = []],
    [
      "duplicate registration",
      (x) => x.found.push({ ...x.found[0], file: "duplicate.ts" }),
    ],
    ["no valid category", (x) => x.listRows[0].category = null],
    [
      "vendor exception",
      (x) =>
        x.listRows.push({ tag: "vendor-fixture", category: "action", line: 2 }),
    ],
    [
      "declared by a story but is not",
      (x) => x.cards[0].tags = ["std-unadmitted"],
    ],
    [
      "declared by 2 stories",
      (x) => x.cards.push({ ...x.cards[0], className: "DuplicateStoryBook" }),
    ],
    ["2 categories", (x) => {
      x.listRows.push({ tag: "std-other", category: "utility", line: 2 });
      x.cards[0].tags.push("std-other");
    }],
    ["stale", (x) => x.onDisk = "older"],
    ["missing", (x) => x.onDisk = null],
  ];
  for (const [message, mutate] of changes) {
    const input = valid();
    mutate(input);
    assert(
      checkComponents(input).some((row) =>
        row.severity === "error" && row.message.includes(message)
      ),
      message,
    );
  }
});

Deno.test("legacy admission and uncovered-story severity retain their policy", () => {
  const input = valid();
  input.found.push({ tag: "std-legacy", file: "legacy.ts", line: 1 });
  input.legacyRows.push({ tag: "std-legacy", category: null, line: 1 });
  assertEquals(checkComponents(input), []);
  input.cards = [];
  assertEquals(checkComponents(input).map((row) => row.severity), ["warn"]);
  assertEquals(checkComponents(input, true).map((row) => row.severity), [
    "error",
  ]);
});

Deno.test("catalogue rules retain orphan warnings and reject duplicate core imports", () => {
  const cards = valid().cards;
  const input = {
    stories: cards,
    examples: [cards[0].example, "tento-ui-js/extension.example.ts"],
  };
  assertEquals(
    checkCatalogue(
      input,
      'import { Extension } from "@tento-ui/extension.example";',
    ),
    [],
  );
  assertEquals(checkCatalogue(input, "").map((row) => row.severity), ["warn"]);
  const result = checkCatalogue(
    input,
    "import { Core } from '@tento-ui/fixture.example.ts';\nimport '@tento-ui/extension.example';",
  );
  assertEquals(result.map((row) => row.severity), ["error"]);
  assert(result[0].message.includes("declares tags AND is imported"));
});

Deno.test("external protocol rejects bad policy and missing catalogue rather than passing", async () => {
  const dir = await Deno.makeTempDir();
  const args = ["rebar-check", "--rule", "-", "--dir", dir, "--json"];
  try {
    await assertRejects(
      () => run(args, '{"check":"unknown"}'),
      Error,
      "Unknown charter check",
    );
    await assertRejects(
      () => run(args, '{"check":"catalogue"}'),
      Error,
      "explicit catalogue path",
    );
    await assertRejects(
      () => run(args, '{"check":"catalogue","catalogue":"missing.ts"}'),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => run(args, '{"check":"catalogue","catalogue":"../escape.ts"}'),
      Error,
      "inside its governing directory",
    );
    await assertRejects(
      () => run(args, '{"check":"components","strict":"false"}'),
      Error,
      "boolean strict",
    );
    await assertRejects(
      () => run(args, '{"check":"components"}'),
      Error,
      "must govern",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("catalogue inventory separates helpers and aliases from extension and core cards", () => {
  const path = "tento-ui-js/fixture.example.ts";
  for (const source of [
    "export namespace FontMetricsExample { export function render() {} }",
    'export { CoreStoryBook as CompatibilityStoryBook } from "./core.example";',
  ]) {
    assertEquals(inspectStorySource(path, source), { examples: [], stories: [] });
  }
  const source = 'export class ExtensionStoryBook extends Storybook.Default {}\n' +
    'export class ExplicitExtensionStoryBook { tags(): string[] { return []; } }\n' +
    'export class CoreStoryBook { tags(): string[] { return ["std-fixture"]; } }';
  const inventory = inspectStorySource(path, source);
  assertEquals(inventory.examples, [path]);
  assertEquals(inventory.stories.map(({ className, tags, example, line }) =>
    ({ className, tags, example, line })), [{
      className: "CoreStoryBook", tags: ["std-fixture"], example: path, line: 3,
    }]);
  assertEquals(checkCatalogue(inventory, "").map(({ severity }) => severity), []);
  assertEquals(checkCatalogue(inspectStorySource(path,
    'export class ExtensionStoryBook extends Storybook.Default {}'), "")
    .map(({ severity }) => severity), ["warn"]);
});
