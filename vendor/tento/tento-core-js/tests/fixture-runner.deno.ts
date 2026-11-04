/**
 * Universal fixture runner.
 *
 * Usage:
 * ```typescript
 * Fixtures.load<I, E>(dir, "data-series").run(
 *   (input) => computeResult(input),
 *   (result, expected) => assertEquals(result, expected),
 * );
 * ```
 *
 * With per-file shared state (e.g. an expensive object built from file-level data):
 * ```typescript
 * Fixtures.load<I, E>(dir, "drag-drop").run(
 *   (input, shared) => computeResult(input, shared.resolver),
 *   (result, expected) => assertEquals(result, expected),
 *   { before: (file) => ({ resolver: new Resolver(file["tree"]) }) },
 * );
 * ```
 */

export class Fixtures<I, E> {
  private constructor(readonly items: Fixtures.File<I, E>[]) {}

  /** Load all `{type}.*.json` fixtures from a directory. */
  static load<I = UntypedJson, E = UntypedJson>(
    dir: string,
    type: string,
  ): Fixtures<I, E> {
    const prefix = type + ".";
    const files: Fixtures.File<I, E>[] = [];
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) continue;
      const raw = JSON.parse(Deno.readTextFileSync(`${dir}/${entry.name}`));
      files.push(raw);
    }
    return new Fixtures(files);
  }

  /** Find a fixture file by name. */
  find(name: string): Fixtures.File<I, E> {
    const f = this.items.find(f => f.name === name);
    if (!f) throw new Error(`fixture "${name}" not found`);
    return f;
  }

  /** Find a specific case, optionally within a named fixture. */
  findCase(fixtureName: string, caseName?: string): Fixtures.Case<I, E> {
    const f = this.find(fixtureName);
    if (caseName) {
      const c = f.cases.find(c => c.name === caseName);
      if (!c) throw new Error(`case "${caseName}" not found in "${fixtureName}"`);
      return c;
    }
    return f.cases[0];
  }

  /**
   * Register Deno.test for every case in every fixture.
   *
   * @param transform — turns fixture input into a test result; receives shared
   *   state produced by `options.before` (undefined when not provided)
   * @param compare — asserts the result matches the expected output
   * @param options — optional `before` hook (runs once per file to build shared
   *   state) plus Deno.test options (ignore, sanitizeOps, etc.)
   */
  run<R, S = undefined>(
    transform: (input: I, shared: S) => R | Promise<R>,
    compare: (result: R, expected: E, caseName: string) => void | Promise<void>,
    options?: { before?: (file: Fixtures.File<I, E>) => S } & Omit<Deno.TestDefinition, "name" | "fn">,
  ): void {
    const { before, ...denoOptions } = options ?? {};
    for (const file of this.items) {
      const shared = before?.(file) as S;
      for (const testCase of file.cases) {
        Deno.test({
          name: `${file.name}: ${testCase.name}`,
          ...denoOptions,
          fn: async () => {
            const result = await transform(testCase.input, shared);
            await compare(result, testCase.expected, testCase.name);
          },
        });
      }
    }
  }
}

export namespace Fixtures {
  export interface File<I = UntypedJson, E = UntypedJson> {
    type: string;
    name: string;
    description?: string;
    cases: Case<I, E>[];
    /** Extra file-level fields (e.g. shared tree, config). Access via `file["key"]`. */
    [key: string]: unknown;
  }

  export interface Case<I = UntypedJson, E = UntypedJson> {
    name: string;
    input: I;
    expected: E;
  }
}
