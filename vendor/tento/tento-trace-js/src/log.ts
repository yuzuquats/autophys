import type { Option } from "./option";
import * as Renderer from "./log-renderer";
import type { FrameContext } from "./log-renderer";

export type LogCategory = "net" | "ui" | "?" | "ini" | "nav" | "sw";
export type LogFunction = (...data: any[]) => void;
export type LogFunctionWithCategory = (c?: Option<LogCategory>) => LogFunction;
export type AdminLog = (
  key: string,
  value: any,
  autoRevealIfAdmin: boolean,
) => void;

// ---------------------------------------------------------------------------
// LogEntry / LogSink — pluggable rendering
// ---------------------------------------------------------------------------

export type LogEntry = {
  level: "info" | "warn" | "error" | "debug";
  category: Option<LogCategory>;
  elapsedMs: number;
  deltaMs: number;
  args: any[];
  frame: Option<FrameContext>;
};

export type LogSink = (entry: LogEntry) => void;

// ---------------------------------------------------------------------------
// Storage-backed toggle
// ---------------------------------------------------------------------------

const LOGGING_ENABLED_KEY = "lona-logging-enabled";

export function toggleLogging(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  if (enabled) {
    localStorage.setItem(LOGGING_ENABLED_KEY, "true");
    Logger.installToConsole();
    console.log("Logging enabled. Refresh to see all logs from startup.");
  } else {
    localStorage.removeItem(LOGGING_ENABLED_KEY);
    console.log("Logging disabled. Refresh to apply.");
  }
}

function isLoggingEnabledInStorage(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(LOGGING_ENABLED_KEY) === "true";
}

// ---------------------------------------------------------------------------
// LoggerUtils — preserved for backwards compatibility (trace decorator, etc.)
// ---------------------------------------------------------------------------

export namespace LoggerUtils {
  let logLevel = 0;

  // Delegate to renderer module
  export const prefix = Renderer.prefix;
  export const timestamp = Renderer.timestamp;
  export const getStartMs = Renderer.getStartMs;

  export function trace(
    _target: Object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<any>,
  ): TypedPropertyDescriptor<any> {
    const method = descriptor.value!;
    descriptor.value = function (...args: any[]) {
      pushLogLevel();
      console.group(
        `%c ${String(this.constructor.name)}.${String(propertyKey)}`,
        "font-weight:400;position:absolute;display:block;color:gray;",
      );
      method.apply(this, args);
      console.groupEnd();
      popLogLevel();
    };
    return descriptor;
  }

  export function pushLogLevel() {
    logLevel += 1;
  }
  export function popLogLevel() {
    logLevel -= 1;
  }
}

// ---------------------------------------------------------------------------
// Binding helpers
// ---------------------------------------------------------------------------

function frameCtx(): Option<FrameContext> {
  return Logger._frameContext();
}

function makeBinding(
  id: string,
  fgColor: string,
  bgColor: string,
): LogFunctionWithCategory {
  return (c) =>
    console.log.bind(
      null,
      ...Renderer.prefix(c, id, fgColor, bgColor, frameCtx()),
    );
}

// Wrapped versions — used when extra sinks are registered
function makeWrappedBinding(
  id: string,
  fgColor: string,
  bgColor: string,
  level: LogEntry["level"],
): LogFunctionWithCategory {
  return (c) => {
    const frame = frameCtx();
    const bound = console.log.bind(
      null,
      ...Renderer.prefix(c, id, fgColor, bgColor, frame),
    );
    return (...args: any[]) => {
      bound(...args);
      const entry: LogEntry = {
        level,
        category: c ?? null,
        elapsedMs: Renderer.getElapsedMs(),
        deltaMs: Renderer.getDeltaMs(),
        args,
        frame,
      };
      for (const sink of Logger._sinks) sink(entry);
    };
  };
}

function makeDbgBinding(): LogFunction {
  const bound = makeBinding("~", "white", "black")("ui");
  return (...args) => {
    // Keep the pre-bound debug prefix, but open a debug-only frame before
    // printing its first message. Avoid rebuilding the prefix per call.
    Renderer.prepareFrame(frameCtx());
    bound(...args);
  };
}

function makeWrappedDbgBinding(): LogFunction {
  return (...args: any[]) => {
    const frame = frameCtx();
    console.log(
      ...Renderer.prefix("ui", "~", "white", "black", frame),
      ...args,
    );
    const entry: LogEntry = {
      level: "debug",
      category: "ui",
      elapsedMs: Renderer.getElapsedMs(),
      deltaMs: Renderer.getDeltaMs(),
      args,
      frame,
    };
    for (const sink of Logger._sinks) sink(entry);
  };
}

// ---------------------------------------------------------------------------
// Noop
// ---------------------------------------------------------------------------

const _noop: LogFunctionWithCategory = () => () => {};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export let dev: LogFunction = _noop;

export class Logger {
  static enabled: boolean = false;

  static noop = _noop;

  static info: LogFunctionWithCategory = _noop;
  static warn: LogFunctionWithCategory = _noop;
  static err: LogFunctionWithCategory = _noop;
  static dbg: LogFunction = () => {};
  static admin = (
    key: string,
    value: any,
    autoRevealIfAdmin: boolean = false,
  ) =>
    globalThis["AdminControls"]?.log(key, value, autoRevealIfAdmin) ??
    (() => {});

  // --- Sink registry ---
  /** @internal */
  static _sinks: LogSink[] = [];
  /** @internal */
  static _frameContext: () => Option<FrameContext> = () => null;

  static addSink(sink: LogSink): void {
    Logger._sinks.push(sink);
    // Re-install bindings in wrapped mode
    if (Logger.enabled) Logger._reinstall();
  }

  static removeSink(sink: LogSink): void {
    const idx = Logger._sinks.indexOf(sink);
    if (idx >= 0) Logger._sinks.splice(idx, 1);
    // Switch back to pure bindings if no sinks remain
    if (Logger.enabled) Logger._reinstall();
  }

  static setFrameContext(fn: () => Option<FrameContext>): void {
    Logger._frameContext = fn;
  }

  // --- Installation ---

  static install(isServiceAccount: boolean, isBeta: boolean) {
    if (!isServiceAccount && !isBeta && !isLoggingEnabledInStorage()) return;
    Logger.installToConsole();
  }

  static installToConsole() {
    Logger.enabled = true;
    Logger._reinstall();
  }

  /** @internal — re-build all bindings (pure vs wrapped based on sink count) */
  static _reinstall(): void {
    if (Logger._sinks.length === 0) {
      // Category bindings preserve Chrome source lines. Debug resolves its
      // frame context at invocation, just as the wrapped debug binding does.
      Logger.info = makeBinding("i", "black", "#999cfe");
      Logger.warn = makeBinding("w", "black", "#fbd55a");
      Logger.err = makeBinding("e", "black", "#fe887c");
      Logger.dbg = makeDbgBinding();
    } else {
      // Wrapped mode — extra sinks receive entries
      Logger.info = makeWrappedBinding("i", "black", "#999cfe", "info");
      Logger.warn = makeWrappedBinding("w", "black", "#fbd55a", "warn");
      Logger.err = makeWrappedBinding("e", "black", "#fe887c", "error");
      Logger.dbg = makeWrappedDbgBinding();
    }
    dev = Logger.dbg;
    (globalThis as any)["dbg"] = Logger.dbg;
    (globalThis as any)["dev"] = Logger.dbg;
  }

  static flushStart(count: number): void {
    if (!Logger.enabled) return;
    Renderer.flushHeader(count);
  }

  static flushEnd(): void {
    if (!Logger.enabled) return;
    Renderer.flushFooter();
  }
}

export const sw = Logger.info("sw");

// Set up logging globals
(globalThis as any)["dbg"] = Logger.noop;
(globalThis as any)["dev"] = Logger.noop;
(globalThis as any)["toggleLogging"] = toggleLogging;
(globalThis as any)["isLoggingEnabled"] = isLoggingEnabledInStorage;
