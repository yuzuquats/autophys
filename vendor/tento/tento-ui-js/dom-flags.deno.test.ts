import { assertEquals } from "@std/assert";
import { DomFlags } from "./dom-flags.ts";

/**
 * `DomFlags.describe` / `describeCount`: the one answer to "what does this
 * page run for a lever, and where did it come from". A debug surface (lona's
 * perf flag profile) reads it instead of re-reading the URL and storage
 * itself, so the read rule lives here only:
 * `?flag:<name>` beats `debug-flag:<name>` storage beats the default, a
 * boolean is on only for "true", a count that is not a whole number reads as
 * its default, and the page value is read once.
 *
 * Each test uses its own flag names: the page values are kept for the module's
 * lifetime, as on a page.
 */

function at(search: string): void {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: new URL(`http://localhost/${search}`),
  });
}

function withStored(entries: Record<string, string>, run: () => void): void {
  for (const [name, value] of Object.entries(entries)) localStorage.setItem(`debug-flag:${name}`, value);
  try {
    run();
  } finally {
    for (const name of Object.keys(entries)) localStorage.removeItem(`debug-flag:${name}`);
  }
}

Deno.test("dom flags describe: a value stored after the page read the flag runs on reload, not now", () => {
  at("");
  const name = "dom-flags-test-stored-late";
  assertEquals(DomFlags.read(name, true), true, "the page reads the default on load");
  withStored({ [name]: "false" }, () => {
    assertEquals(DomFlags.read(name, true), true, "a stored change applies on reload");
    assertEquals(DomFlags.describe(name, true), {
      value: true,
      source: "default",
      pageValue: true,
      pageSource: "default",
      onReload: { value: false, source: "storage" },
    });
  });
});

Deno.test("dom flags describe: reads the page value once when nothing has, and read answers the same after", () => {
  at("");
  const name = "dom-flags-test-first-read";
  withStored({ [name]: "true" }, () => {
    assertEquals(DomFlags.describe(name, false), {
      value: true,
      source: "storage",
      pageValue: true,
      pageSource: "storage",
      onReload: { value: true, source: "storage" },
    });
  });
  assertEquals(DomFlags.read(name, false), true, "describe's read is the page's one read");
  assertEquals(DomFlags.describe(name, false).onReload, { value: false, source: "default" });
});

Deno.test("dom flags describe: ?flag: beats storage, and a boolean is on only for \"true\"", () => {
  const url = "dom-flags-test-url";
  const yes = "dom-flags-test-yes";
  at(`?flag:${url}=true`);
  withStored({ [url]: "false", [yes]: "yes" }, () => {
    assertEquals(DomFlags.describe(url, false).value, true);
    assertEquals(DomFlags.describe(url, false).source, "url");
    assertEquals(DomFlags.describe(yes, true).value, false);
    assertEquals(DomFlags.describe(yes, true).source, "storage");
  });
  at("");
});

Deno.test("dom flags describe: a harness override is what runs, with the page value beside it", () => {
  at("");
  const name = "dom-flags-test-harness";
  DomFlags.armForHarness(name, false);
  try {
    assertEquals(DomFlags.read(name, true), false);
    assertEquals(DomFlags.describe(name, true), {
      value: false,
      source: "harness",
      pageValue: true,
      pageSource: "default",
      onReload: { value: true, source: "default" },
    });
  } finally {
    DomFlags.armForHarness(name, null);
  }
  assertEquals(DomFlags.describe(name, true).source, "default");
});

Deno.test("dom flags describeCount: the count form; a value that is not a whole number reads as the default", () => {
  const url = "dom-flags-test-count-url";
  const bad = "dom-flags-test-count-bad";
  const late = "dom-flags-test-count-late";
  at(`?flag:${url}=12`);
  assertEquals(DomFlags.readCount(late, 20), 20);
  withStored({ [url]: "3", [bad]: "fast", [late]: "5" }, () => {
    assertEquals(DomFlags.describeCount(url, 20), {
      value: 12,
      source: "url",
      pageValue: 12,
      pageSource: "url",
      onReload: { value: 12, source: "url" },
    });
    assertEquals([DomFlags.describeCount(bad, 6).value, DomFlags.describeCount(bad, 6).source], [6, "storage"]);
    assertEquals(DomFlags.describeCount(late, 20), {
      value: 20,
      source: "default",
      pageValue: 20,
      pageSource: "default",
      onReload: { value: 5, source: "storage" },
    });
    DomFlags.armForHarness(late, 9);
    try {
      const described = DomFlags.describeCount(late, 20);
      assertEquals([DomFlags.readCount(late, 20), described.value, described.source], [9, 9, "harness"]);
    } finally {
      DomFlags.armForHarness(late, null);
    }
  });
  at("");
});
