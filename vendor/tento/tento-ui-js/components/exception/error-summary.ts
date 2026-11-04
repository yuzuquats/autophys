// Turns whatever a promise was rejected with into something a person can read.
//
// `unhandledrejection` hands over `event.reason`, which is any value at all:
// an Error (whose message is the only useful part), a DOMException, a string,
// `null`, a `Response`, an `Event` from a failed <script> or socket, or a plain
// object. The toast used to title every one of them "Promise Rejection" and
// show only the stack minus its first line — and for an Error that first line
// IS the message, so a failed dynamic import arrived as a red box with nothing
// in it. This module is the one place that knows how to name each kind.
//
// Pure: no DOM construction, no globals beyond `instanceof` probes, so the
// whole surface runs under `deno test`.
export namespace ErrorSummary {
  export type Summary = {
    /** One line saying what went wrong — the error's own `Name: message`. */
    title: string;
    /** A real stack, header included. `frames()` strips the header. */
    stack?: Option<string>;
    /** Everything else worth reading: causes, aggregated errors, extra fields,
     *  or a dump of a non-Error value. */
    detail?: Option<string>;
  };

  const TITLE_MAX = 200;
  const DUMP_MAX = 2000;
  const CAUSE_DEPTH = 4;
  const STANDARD_ERROR_KEYS = new Set(["name", "message", "stack", "cause", "errors"]);

  /** Summarise an unhandled rejection's `reason`. */
  export function ofRejection(reason: unknown): Summary {
    if (isErrorLike(reason)) return ofError(reason);
    if (typeof reason === "string") {
      const [first, ...rest] = reason.split("\n");
      const title = truncate(first, TITLE_MAX);
      return {
        title: `Promise rejected: ${title}`,
        detail: rest.length > 0 || title !== first ? reason : null,
      };
    }
    if (reason == null || typeof reason !== "object") {
      // null, undefined, numbers, booleans, symbols, bigints: the value is all
      // there is. `String()` because a symbol refuses template interpolation.
      return { title: `Promise rejected with ${String(reason)}` };
    }
    if (typeof Response !== "undefined" && reason instanceof Response) {
      return {
        title: `Promise rejected with HTTP ${reason.status} ${reason.statusText}`.trim(),
        detail: reason.url || null,
      };
    }
    if (typeof Event !== "undefined" && reason instanceof Event) {
      return {
        title: `Promise rejected with a "${reason.type}" event`,
        detail: describeEventTarget(reason.target),
      };
    }
    return {
      title: `Promise rejected with ${constructorName(reason) ?? "an object"}`,
      detail: dump(reason),
    };
  }

  /** Summarise an Error (or anything shaped like one — errors from another
   *  realm fail `instanceof Error`). */
  export function ofError(e: ErrorLike): Summary {
    const sections: string[] = [];
    const extras = extraFields(e);
    if (extras) sections.push(extras);
    const errors = (e as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      sections.push(
        errors
          .map((inner, i) => `[${i}] ${isErrorLike(inner) ? title(inner) : ofRejection(inner).title}`)
          .join("\n"),
      );
    }
    let cause = e.cause;
    for (let depth = 0; cause != null && depth < CAUSE_DEPTH; depth++) {
      if (!isErrorLike(cause)) {
        sections.push(`Caused by: ${ofRejection(cause).title}`);
        break;
      }
      const causeFrames = frames(cause.stack);
      sections.push(`Caused by: ${title(cause)}${causeFrames ? `\n${causeFrames}` : ""}`);
      cause = cause.cause;
    }
    return {
      title: title(e),
      stack: typeof e.stack === "string" ? e.stack : null,
      detail: sections.length > 0 ? sections.join("\n\n") : null,
    };
  }

  /** `Name: message`, or whichever half exists. */
  export function title(e: ErrorLike): string {
    const name = typeof e.name === "string" && e.name ? e.name : "Error";
    const message = typeof e.message === "string" ? e.message.trim() : "";
    return truncate(message ? `${name}: ${message}` : name, TITLE_MAX);
  }

  /** The frames of a stack, without the header V8 puts in front of them.
   *
   *  V8 begins a stack with `Name: message` (which can span several lines);
   *  Firefox and Safari do not, and begin with a frame. So drop leading lines
   *  only up to the first line that is a frame — dropping exactly one line, as
   *  this used to, threw away a real frame on Safari and Firefox. A stack with
   *  no frames at all (`TypeError: Failed to fetch dynamically imported
   *  module: …`) is all header, and yields nothing. */
  export function frames(stack: Option<string>): string {
    if (!stack) return "";
    const lines = stack.split("\n");
    const first = lines.findIndex(isFrame);
    if (first < 0) return "";
    return lines.slice(first).join("\n").trimEnd();
  }

  export type ErrorLike = {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    cause?: unknown;
  };

  export function isErrorLike(value: unknown): value is ErrorLike & { stack?: Option<string> } {
    if (value instanceof Error) return true;
    if (value == null || typeof value !== "object") return false;
    const v = value as ErrorLike;
    return typeof v.message === "string" && (typeof v.name === "string" || typeof v.stack === "string");
  }

  // V8: `    at fn (url:1:2)`. Firefox / Safari: `fn@url:1:2`, `@url:1:2`,
  // `global code@url:1:2`, `fn@[native code]`. Anchored on the trailing
  // position, because a bare `@` matches too much — a message naming
  // `https://host/@/static/js/x.js` is not a frame.
  function isFrame(line: string): boolean {
    return /^\s*at\s/.test(line) || /@\S*:\d+:\d+$|@\[native code\]$/.test(line.trimEnd());
  }

  // Own fields beyond the standard ones: `code`, `status`, `url`, `errno`…
  // These are often the actual answer (a fetch wrapper's status, a node-style
  // error code) and appear in no stack.
  function extraFields(e: object): string {
    const lines: string[] = [];
    for (const key of Object.keys(e)) {
      if (STANDARD_ERROR_KEYS.has(key)) continue;
      const value = (e as Record<string, unknown>)[key];
      if (typeof value === "function") continue;
      lines.push(`${key}: ${truncate(dump(value) ?? String(value), TITLE_MAX)}`);
    }
    return lines.join("\n");
  }

  function describeEventTarget(target: Option<EventTarget>): Option<string> {
    if (target == null) return null;
    const t = target as Partial<{ tagName: string; src: string; href: string; url: string; error: unknown }>;
    const parts: string[] = [];
    const name = typeof t.tagName === "string" ? `<${t.tagName.toLowerCase()}>` : constructorName(target);
    if (name) parts.push(name);
    const where = t.src || t.href || t.url;
    if (typeof where === "string" && where) parts.push(where);
    if (isErrorLike(t.error)) parts.push(title(t.error));
    return parts.length > 0 ? parts.join(" ") : null;
  }

  function constructorName(value: object): Option<string> {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name && name !== "Object" ? name : null;
  }

  /** JSON when it will go, `String()` when it will not (cycles, BigInt). */
  function dump(value: unknown): Option<string> {
    if (typeof value === "string") return JSON.stringify(value);
    let text: Option<string> = null;
    try {
      text = JSON.stringify(value, null, 2) ?? null;
    } catch {
      // fall through to String()
    }
    if (text == null || text === "{}") {
      try {
        text = String(value);
      } catch {
        return null;
      }
    }
    return truncate(text, DUMP_MAX);
  }

  function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
}
