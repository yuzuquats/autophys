import type { Option } from "./option";
import type { LogCategory } from "./log";

export type FrameContext = {
  count: number;
  phase: "reads" | "writes" | "writes-end";
};

const categoryToBgColor: { [k in LogCategory]: string } = {
  net: "#cbe9c8",
  ini: "#999cff",
  ui: "#999cff",
  nav: "#dbacff",
  "?": "#d1d1d1",
  sw: "#fe887c",
};

const flushColor = "#00cec9";

const phaseColors: { [k in FrameContext["phase"]]: string } = {
  reads: "#999cfe",
  writes: "#fbd55a",
  "writes-end": flushColor,
};

const layout = "padding-left:4px;padding-right:4px;border-radius:4px";

const startMs = Date.now();
let lastLogMs = startMs;
let lastDeltaMs = 0;
let pendingFlush: Option<number> = null;
let flushHeaderPrinted = false;

function msToTimeString(ms: number): string {
  if (ms > 30_000) {
    return `${Math.trunc(ms / 1000)}.${Math.trunc(
      (ms % 1000) / 100,
    )}s`.padStart(10, " ");
  } else if (ms > 1_000) {
    return `${Math.trunc(ms / 1000)}.${Math.trunc((ms % 1000) / 10)}s`.padStart(
      10,
      " ",
    );
  } else {
    return `${ms}ms`.padStart(10, " ");
  }
}

export function timestamp(): string {
  const prevLastLogMs = lastLogMs;
  lastLogMs = Date.now();
  lastDeltaMs = lastLogMs - prevLastLogMs;
  let sb = msToTimeString(lastLogMs - startMs);
  sb += lastDeltaMs > 0 ? msToTimeString(lastDeltaMs) : "          ";
  return sb;
}

export function getElapsedMs(): number {
  return lastLogMs - startMs;
}

export function getDeltaMs(): number {
  return lastDeltaMs;
}

export function getStartMs(): number {
  return startMs;
}

export function prefix(
  category: Option<LogCategory>,
  id: string,
  fgColor: string,
  bgColor: string,
  frame: Option<FrameContext>,
): any[] {
  const catStr = String(category ?? "?").padStart(4, " ");
  const ts = timestamp();
  const idStyle = `color:${fgColor};background-color:${bgColor};${layout};margin-left:14px;margin-right:4px;`;
  const catStyle = `color:black;background-color:${categoryToBgColor[category ?? "?"]};${layout};margin-right:4px;`;
  if (frame) {
    prepareFrame(frame);
    return [
      `%c│%c  %c${id}%c${catStr}%c${ts}%c      ›`,
      `color:${flushColor};`,
      "",
      idStyle,
      catStyle,
      "",
      "margin-right: 10px;",
    ];
  }
  return [
    `   %c${id}%c${catStr}%c${ts}%c      ›`,
    idStyle,
    catStyle,
    "",
    "margin-right: 10px;",
  ];
}

/** Open the pending bracket before a normal or pre-bound debug message. */
export function prepareFrame(frame: Option<FrameContext>): void {
  if (!frame || pendingFlush !== frame.count || flushHeaderPrinted) return;
  flushHeaderPrinted = true;
  console.log(
    `%c╭─ Flush ${frame.count} ${"─".repeat(28)}`,
    `color: ${flushColor};`,
  );
}

export function flushHeader(count: number): void {
  // Most scrolling frames have no log messages. Open their console bracket
  // only when a message requests a frame prefix, avoiding three empty calls.
  pendingFlush = count;
  flushHeaderPrinted = false;
}

export function flushFooter(): void {
  if (flushHeaderPrinted) {
    console.log(`%c╰${"─".repeat(38)}`, `color: ${flushColor};`);
    console.log("");
  }
  pendingFlush = null;
  flushHeaderPrinted = false;
}
