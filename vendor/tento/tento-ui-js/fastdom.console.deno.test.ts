import { assertEquals } from "jsr:@std/assert";
import { type LogEntry, Logger } from "../tento-trace-js/src/log.ts";

const frames: EmptyFunction[] = [];
Object.defineProperty(globalThis, "window", {
  value: { requestAnimationFrame: (fn: EmptyFunction) => frames.push(fn) },
  configurable: true,
});
const { Fastdom } = await import("./fastdom.ts");

class Harness {
  readonly calls: Parameters<typeof console.log>[] = [];
  readonly fastdom = new Fastdom();
  private readonly log = console.log;

  constructor() {
    console.log = (...args) => {
      this.calls.push(args);
    };
    Logger.installToConsole();
  }
  flush(): void {
    frames.shift()?.();
  }
  headers(): number {
    return this.calls.filter((args) => String(args[0]).includes("╭─ Flush"))
      .length;
  }
  footers(): number {
    return this.calls.filter((args) => String(args[0]).startsWith("%c╰"))
      .length;
  }
  restore(): void {
    console.log = this.log;
    Logger.enabled = false;
    Logger._sinks.length = 0;
    Logger.info = Logger.noop;
    Logger.warn = Logger.noop;
    Logger.err = Logger.noop;
    Logger.dbg = () => {};
    frames.length = 0;
  }
}

Deno.test("fastdom console: a flush without messages makes no console calls", () => {
  const h = new Harness();
  try {
    h.fastdom.measure(() => {});
    h.fastdom.mutate(() => {});
    h.flush();
    assertEquals(h.calls.length, 0);
  } finally {
    h.restore();
  }
});

Deno.test("fastdom console: first debug message opens one frame and preserves message order", () => {
  const h = new Harness();
  try {
    h.fastdom.measure(() => Logger.dbg("read-message"));
    h.fastdom.mutate(() => Logger.info("ui")("write-message"));
    h.fastdom.mutateEnd(() => Logger.warn("ui")("end-message"));
    h.flush();
    assertEquals(h.headers(), 1);
    assertEquals(h.footers(), 1);
    assertEquals(h.calls.slice(1, 4).map((args) => args.at(-1)), [
      "read-message",
      "write-message",
      "end-message",
    ]);
    assertEquals(
      String(h.calls[0][0]).includes("Flush 0"),
      true,
      "the debug-only opening must use the current frame count",
    );
    assertEquals(h.calls.length, 6);
  } finally {
    h.restore();
  }
});

Deno.test("fastdom console: silent following frame and outside-frame messages do not inherit brackets", () => {
  const h = new Harness();
  try {
    h.fastdom.measure(() => Logger.info("ui")("first"));
    h.flush();
    const count = h.calls.length;
    h.fastdom.measure(() => {});
    h.flush();
    assertEquals(h.calls.length, count);
    Logger.dbg("outside");
    assertEquals(h.calls.length, count + 1);
    assertEquals(h.headers(), 1);
    assertEquals(h.footers(), 1);
    assertEquals(String(h.calls.at(-1)?.[0]).startsWith("   %c"), true);
  } finally {
    h.restore();
  }
});

Deno.test("fastdom console: sinks keep every message and its phase across binding modes", () => {
  const h = new Harness();
  const entries: LogEntry[] = [];
  const sink = (entry: LogEntry): void => {
    entries.push(entry);
  };
  try {
    Logger.addSink(sink);
    h.fastdom.measure(() => Logger.dbg("read"));
    h.fastdom.mutate(() => Logger.err("ui")("write"));
    h.fastdom.mutateEnd(() => Logger.info("ui")("end"));
    h.flush();
    assertEquals(entries.map((e) => [e.args[0], e.frame?.phase]), [
      ["read", "reads"],
      ["write", "writes"],
      ["end", "writes-end"],
    ]);
    assertEquals(h.headers(), 1);
    Logger.removeSink(sink);
    h.fastdom.measure(() => Logger.dbg("pure-again"));
    h.flush();
    assertEquals(entries.length, 3);
    assertEquals(h.headers(), 2);
    assertEquals(h.footers(), 2);
  } finally {
    h.restore();
  }
});
