import { assertEquals } from "jsr:@std/assert";

import { Debounce, debounce } from "./debounce.ts";

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

Deno.test("debounce returns a completion promise for the scheduled function", async () => {
  await Debounce.flush();
  let runs = 0;

  const done = debounce("completion", async () => {
    runs += 1;
  }, 1);

  assertEquals(runs, 0);
  await done;
  assertEquals(runs, 1);
});

Deno.test("Debounce.flush waits for timer-started functions", async () => {
  await Debounce.flush();
  let running = false;
  let finished = false;
  let releaseRun: () => void = () => {};

  const done = debounce("running-flush", async () => {
    running = true;
    await new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    finished = true;
  }, 1);

  await waitUntil(() => running);

  let flushResolved = false;
  const flushed = Debounce.flush().then(() => {
    flushResolved = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));

  assertEquals(flushResolved, false);
  assertEquals(finished, false);
  releaseRun();

  await flushed;
  await done;
  assertEquals(finished, true);
  assertEquals(flushResolved, true);
});

Deno.test("Debounce.flushMatching ignores unrelated queued functions", async () => {
  await Debounce.flush();
  const runs: string[] = [];

  const cellDone = debounce("cell:one", async () => {
    runs.push("cell");
  }, 10_000);
  const unrelatedDone = debounce("theme:one", async () => {
    runs.push("theme");
  }, 10_000);

  await Debounce.flushMatching((key) => key.includes("cell:"));
  assertEquals(runs, ["cell"]);

  await Debounce.flush();
  await cellDone;
  await unrelatedDone;
  assertEquals(runs, ["cell", "theme"]);
});

Deno.test("Debounce.flushMatchingReport describes matching queued functions", async () => {
  await Debounce.flush();
  const runs: string[] = [];

  const cellDone = debounce("cell:report", async () => {
    runs.push("cell");
  }, 10_000);
  const unrelatedDone = debounce("theme:report", async () => {
    runs.push("theme");
  }, 10_000);

  const report = await Debounce.flushMatchingReport((key) =>
    key.includes("cell:")
  );
  assertEquals(report.queuedStart, 2);
  assertEquals(report.activeStart, 0);
  assertEquals(report.queuedExecuted, 1);
  assertEquals(report.queuedKeys, ['"cell:report"']);
  assertEquals(report.activeWaits, []);
  assertEquals(runs, ["cell"]);

  await Debounce.flush();
  await cellDone;
  await unrelatedDone;
  assertEquals(runs, ["cell", "theme"]);
});

Deno.test("Debounce.flushMatching ignores unrelated active flush batches", async () => {
  await Debounce.flush();
  const runs: string[] = [];
  let releaseTheme: () => void = () => {};

  const themeDone = debounce("theme:slow", async () => {
    runs.push("theme-start");
    await new Promise<void>((resolve) => {
      releaseTheme = resolve;
    });
    runs.push("theme-end");
  }, 10_000);
  const cellDone = debounce("cell:fast", async () => {
    runs.push("cell");
  }, 10_000);

  const themeFlush = Debounce.flushMatching((key) => key.includes("theme:"));
  await waitUntil(() => runs.includes("theme-start"));

  const cellReport = await Debounce.flushMatchingReport((key) =>
    key.includes("cell:")
  );
  assertEquals(cellReport.activeWaits, []);
  assertEquals(runs, ["theme-start", "cell"]);

  releaseTheme();
  await themeFlush;
  await Debounce.flush();
  await themeDone;
  await cellDone;
  assertEquals(runs, ["theme-start", "cell", "theme-end"]);
});

Deno.test("Debounce.flush resolves queued completion promises", async () => {
  await Debounce.flush();
  let runs = 0;

  const done = debounce("flush-completion", async () => {
    runs += 1;
  }, 10_000);

  await Debounce.flush();
  await done;
  assertEquals(runs, 1);
});
