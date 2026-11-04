import { assertEquals, assertRejects } from "@std/assert";
import { Tracing } from "@tento-core/tracing";
import { VendoredImport } from "./vendored-import.ts";

type Captured = { level: string; label: string; data: unknown };

// Sinks only receive entries once logging is installed (wrapped bindings);
// `deno test` runs each test module in its own isolate, so this stays here.
Tracing.installToConsole();

function capture(): { entries: Captured[]; stop: () => void } {
  const entries: Captured[] = [];
  const sink = (entry: { level: string; args: unknown[] }) => {
    const [label, data] = entry.args;
    entries.push({ level: entry.level, label: String(label), data });
  };
  Tracing.addSink(sink);
  return { entries, stop: () => Tracing.removeSink(sink) };
}

function importerOf(outcomes: Record<string, "ok" | "fail">) {
  const calls: string[] = [];
  const importer = (url: string): Promise<string> => {
    calls.push(url);
    return outcomes[url] === "ok"
      ? Promise.resolve("module:" + url)
      : Promise.reject(new Error("failed to fetch " + url));
  };
  return { calls, importer };
}

const SUBDOMAIN = "https://static.example.test/js/prosemirror.min.js?v=3";
const SAME_ORIGIN = "/@/static/js/prosemirror.min.js?v=3";

Deno.test("VendoredImport.load: the first URL loads, no retry", async () => {
  const { calls, importer } = importerOf({ [SUBDOMAIN]: "ok" });
  const got = await VendoredImport.load(
    { label: "prosemirror", url: SUBDOMAIN, fallbackUrl: SAME_ORIGIN },
    importer,
  );
  assertEquals(got, "module:" + SUBDOMAIN);
  assertEquals(calls, [SUBDOMAIN]);
});

Deno.test("VendoredImport.load: a failed static-subdomain URL retries same-origin", async () => {
  const { calls, importer } = importerOf({ [SUBDOMAIN]: "fail", [SAME_ORIGIN]: "ok" });
  const got = await VendoredImport.load(
    { label: "prosemirror", url: SUBDOMAIN, fallbackUrl: SAME_ORIGIN },
    importer,
  );
  assertEquals(got, "module:" + SAME_ORIGIN);
  assertEquals(calls, [SUBDOMAIN, SAME_ORIGIN]);
});

Deno.test("VendoredImport.load: a failed same-origin URL is not retried, and the failure is logged", async () => {
  const log = capture();
  try {
    const { calls, importer } = importerOf({ [SAME_ORIGIN]: "fail" });
    await assertRejects(
      () =>
        VendoredImport.load(
          { label: "prosemirror", url: SAME_ORIGIN, fallbackUrl: SAME_ORIGIN },
          importer,
        ),
      Error,
      "failed to fetch " + SAME_ORIGIN,
    );
    assertEquals(calls, [SAME_ORIGIN]);
    const failed = log.entries.filter((e) => e.label === "prosemirror/init-failed");
    assertEquals(failed.map((e) => e.level), ["warn"]);
    assertEquals(failed[0].data, {
      url: SAME_ORIGIN,
      error: "failed to fetch " + SAME_ORIGIN,
      retried: false,
    });
  } finally {
    log.stop();
  }
});

Deno.test("VendoredImport.load: a failed retry is logged with both URLs", async () => {
  const log = capture();
  try {
    const { calls, importer } = importerOf({});
    await assertRejects(
      () =>
        VendoredImport.load(
          { label: "codemirror", url: SUBDOMAIN, fallbackUrl: SAME_ORIGIN },
          importer,
        ),
      Error,
      "failed to fetch " + SAME_ORIGIN,
    );
    assertEquals(calls, [SUBDOMAIN, SAME_ORIGIN]);
    const failed = log.entries.filter((e) => e.label === "codemirror/init-failed");
    assertEquals(failed.map((e) => e.level), ["warn"]);
    assertEquals(failed[0].data, {
      url: SAME_ORIGIN,
      error: "failed to fetch " + SAME_ORIGIN,
      firstUrl: SUBDOMAIN,
      firstError: "failed to fetch " + SUBDOMAIN,
      retried: true,
    });
  } finally {
    log.stop();
  }
});
