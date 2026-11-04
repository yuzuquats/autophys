/**
 * Where the client's data comes from: one interface, three implementations. `fixtures()`
 * (fixtures/source.ts) replays a canned workspace in the browser; `daemon()` talks to
 * `autophys serve` over /api/v1 (GET /workspace, SSE /stream, POST approvals and pairing
 * decisions); `firstOf()` loads the daemon when it answers and falls back to the fixture.
 * This file holds the client's only network code; wire.ts maps what the daemon sends.
 */
import type { Pairing, Workspace } from "./domain.ts";
import type { Decision } from "./proposal.ts";
import { pairingOf, type WirePairing, type WireRecord, type WireWorkspace, WireModel } from "./wire.ts";

/** A decision record the fixture logs: the SSE payload and the answer to a POST. */
export type DecisionRec = {
  /** Global order, the stream cursor. */
  gseq: number;
  id: string;
  investigation: string;
  /** Per-investigation order. */
  seq: number;
  kind: "proposal";
  ts: string;
  payload: { project: string; proposal: string } & Decision;
};
/** A daemon record of any kind, with the gseq the daemon sent beside it (AX-8). */
export type Cursor = number | string;
export type DaemonRec = { gseq: Cursor; id: string; investigation: string; seq: number; kind: "record"; ts: string; record: WireRecord };
export type Rec = DecisionRec | DaemonRec;

export type Snapshot = {
  source: string;
  workspace: Workspace;
  gseq: Cursor;
  /** Decision events the source records; absent: all of them. */
  events?: readonly Decision["event"][];
  /** Devices waiting to pair (O-3); absent when the source has no pairing. */
  pairings?: Pairing[];
};

export interface Source {
  readonly name: string;
  /** Source-wide failures, including a refused browser session. No host APIs here. */
  readonly onError?: (on: (error: Error) => void) => () => void;
  /** GET /api/v1/workspace. */
  load(): Promise<Snapshot>;
  /** SSE /api/v1/stream?after=<gseq>: every record after the cursor, then live ones. Returns a stop. */
  stream(after: Cursor, on: (r: Rec) => void): () => void;
  /** POST a decision; resolves with the record it became, rejects (an ApiError) when the state forbids it. */
  post(path: string, body: unknown): Promise<Rec>;
  /**
   * The source's own reducer, for a source that re-derives the workspace from its log: it
   * accepts records in any order and more than once, and returns null when nothing changed.
   * Without it the store applies decision records in gseq order (applyRecord).
   */
  readonly fold?: (ws: Workspace, r: Rec) => Workspace | null;
  /** Pending device pairings and the operator's decision on one (O-3). */
  readonly pairings?: { list(): Promise<Pairing[]>; decide(code: string, approve: boolean): Promise<void> };
}

export const approvalsPath = (investigation: string, proposal: string) => `/investigations/${investigation}/proposals/${proposal}/approvals`;

/** A refused request: the daemon's `{error, message, path?}` and its HTTP status (0: no answer). */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly path?: string) {
    super(`${status ? `${status} ` : ""}${code}: ${path ? `${path}: ` : ""}${message}`);
    this.name = "ApiError";
  }
}

/** The part of EventSource the daemon source uses (so tests can fake it). */
export type EventStream = {
  addEventListener(type: "record", fn: (e: { data: string; lastEventId: string }) => void): void;
  addEventListener(type: "open" | "error", fn: () => void): void;
  close(): void;
};

export type DaemonOptions = {
  base?: string;
  fetch?: typeof globalThis.fetch;
  openStream?: (url: string) => EventStream;
  /** Reconnect delay after the n-th consecutive failure (ms). */
  backoff?: (n: number) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** A fresh client record id (the envelope id and Idempotency-Key). */
  newId?: () => string;
  user?: string;
  /** The host may reload the document to renew its HttpOnly session (AX-9). */
  reauth?: () => void;
};

const RECORDED: readonly Decision["event"][] = ["approved", "edited", "rejected"];

/** The daemon source: `autophys serve`'s /api/v1, cookie-authenticated from its own page (AX-9, O-3). */
export function daemon(opts: DaemonOptions = {}): Source {
  const base = opts.base ?? "/api/v1";
  const http = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const openStream = opts.openStream ?? ((url: string) => new EventSource(url) as unknown as EventStream);
  const backoff = opts.backoff ?? ((n: number) => Math.min(10_000, 250 * 2 ** n));
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as number));
  const newId = opts.newId ?? (() => `ui-${crypto.randomUUID()}`);
  let model: WireModel | null = null;
  let refreshing: Promise<void> | null = null;
  const listeners = new Set<(r: Rec) => void>();
  const errors = new Set<(error: Error) => void>();
  let authFailed = false;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await http(`${base}${path}`, {
        method, credentials: "same-origin", signal: AbortSignal.timeout(10_000),
        // A browser write needs its session cookie and JSON (else 415); the browser adds its Origin (else 403), O-3.
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const failure = new ApiError(0, "unreachable", String((error as Error)?.message ?? error));
      for (const on of errors) on(failure);
      throw failure;
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: string; message?: string; path?: string };
      if (res.status === 401 && !authFailed) {
        authFailed = true;
        opts.reauth?.();
        const error = new ApiError(401, "session_expired", "Browser session expired. Reload this page to reconnect.");
        for (const on of errors) on(error);
      }
      throw new ApiError(res.status, e.error ?? "http", e.message ?? (res.statusText || "request failed"), e.path);
    }
    if (json === null) throw new ApiError(res.status, "not_json", `${path} did not answer JSON`);
    return json as T;
  }

  const recOf = (gseq: Cursor, record: WireRecord): DaemonRec =>
    ({ gseq, id: record.id, investigation: record.investigation, seq: record.seq, kind: "record", ts: String(record.ts), record });

  /** A record pinned to a project or config version loaded after us: refetch the reference data, then re-fold. */
  function refresh(r: Rec): void {
    refreshing ??= call<WireWorkspace>("GET", "/workspace").then((w) => {
      model?.reference(w);
      for (const rec of w.records) model?.add(rec);
      for (const l of listeners) l(r);
    }).catch(() => {}).finally(() => { refreshing = null; });
  }

  return {
    name: "daemon",
    onError(on) { errors.add(on); return () => { errors.delete(on); }; },
    async load() {
      const w = await call<WireWorkspace>("GET", "/workspace");
      if (!w || !Array.isArray(w.projects) || !Array.isArray(w.records) || !(typeof w.cursor === "number" || typeof w.cursor === "string")) throw new ApiError(200, "not_a_workspace", "/workspace did not answer a workspace");
      model = new WireModel(w, opts.user);
      const workspace = model.workspace();
      model.takeChanged();
      return { source: "daemon", workspace, gseq: w.cursor, events: RECORDED, pairings: [] };
    },
    fold(_ws, r) {
      if (!model || r.kind !== "record") return null;
      model.add(r.record);
      if (!model.takeChanged()) return null;
      const ws = model.workspace();
      if (model.stale) refresh(r);
      return ws;
    },
    stream(after, on) {
      let cursor = after, failures = 0, live = true, es: EventStream | null = null, timer: unknown = null;
      listeners.add(on);
      const open = () => {
        timer = null;
        if (!live) return;
        const s = es = openStream(`${base}/stream?after=${encodeURIComponent(String(cursor))}`);
        s.addEventListener("open", () => { failures = 0; });
        s.addEventListener("record", (e) => {
          if (!live || es !== s || !e.lastEventId) return;
          // Unscoped event ids are opaque collection cursors. A POST gseq belongs
          // to just one workbook and must never advance this stream cursor.
          const gseq = typeof cursor === "number" ? Number(e.lastEventId) : e.lastEventId;
          let record: WireRecord;
          try { record = JSON.parse(e.data); } catch { return; }
          if (typeof gseq === "number" && (!Number.isFinite(gseq) || gseq <= Number(cursor))) return;
          if (!record || typeof record.id !== "string" || typeof record.investigation !== "string" || !Number.isInteger(record.seq) || !record.payload || typeof record.payload !== "object") return;
          cursor = gseq;
          if (live) on(recOf(gseq, record));
        });
        // EventSource retries by itself with Last-Event-ID, but gives up on an HTTP error;
        // reopen ourselves from the last gseq seen, with a growing delay.
        s.addEventListener("error", () => {
          if (es !== s) return;
          s.close();
          es = null;
          // Native EventSource hides the response status. Probe a small cookie-
          // protected read to distinguish an expired session from a dropped connection.
          void call("GET", "/pairings").catch(() => {}).finally(() => {
            if (live && !authFailed) timer = setTimer(open, backoff(failures++));
          });
        });
      };
      open();
      return () => {
        live = false;
        listeners.delete(on);
        es?.close();
        if (timer != null) clearTimer(timer);
      };
    },
    async post(path, body) {
      const m = /^\/investigations\/([^/]+)\/proposals\/([^/]+)\/approvals$/.exec(path);
      if (!m) throw new ApiError(404, "not_found", `no daemon route for ${path}`);
      const [, inv, pid] = m, d = body as Decision;
      if (!RECORDED.includes(d.event)) throw new ApiError(400, "unsupported", `the daemon records no ${d.event} decision (only ${RECORDED.join(", ")})`);
      const payload: Record<string, unknown> = { proposal_id: decodeURIComponent(pid), event: d.event, by: d.by ?? opts.user ?? "browser" };
      // An edit sends every setting as proposed, the edited ones replaced: the daemon refuses a
      // change to a setting that is not an outlook axis, and the SDK runs what is approved.
      if (d.event === "edited") payload.settings = { ...(model?.settings(decodeURIComponent(inv), decodeURIComponent(pid)) ?? {}), ...(d.fields ?? {}) };
      const id = newId();
      const out = await call<{ record: WireRecord; gseq: number }>("POST", path, { id, kind: "proposal", payload }, { "idempotency-key": id });
      return recOf(out.gseq, out.record);
    },
    pairings: {
      async list() {
        const out = await call<{ pairings: WirePairing[] }>("GET", "/pairings");
        return (out.pairings ?? []).map(pairingOf);
      },
      async decide(code, approve) {
        await call("POST", `/pairings/${encodeURIComponent(code)}/${approve ? "approve" : "deny"}`, {});
      },
    },
  };
}

/** The first source whose load succeeds (the daemon, then the fixture); the others are never used. */
export function firstOf(...sources: Source[]): Source & { readonly chosen: Promise<Source> } {
  let active: Source | null = null;
  const errors = new Set<(error: Error) => void>();
  let stopErrors: (() => void) | undefined;
  let pick: (s: Source) => void = () => {};
  const chosen = new Promise<Source>((resolve) => (pick = resolve));
  const need = () => {
    if (!active) throw new Error("autophys: the source has not loaded yet");
    return active;
  };
  return {
    chosen,
    onError(on) { errors.add(on); return () => { errors.delete(on); }; },
    get name() { return active?.name ?? sources.map((s) => s.name).join(" or "); },
    async load() {
      let last: unknown = null;
      for (const s of sources) {
        stopErrors?.();
        stopErrors = s.onError?.((error) => { for (const on of errors) on(error); });
        try {
          const snap = await s.load();
          active = s;
          pick(s);
          return snap;
        } catch (error) {
          // A real daemon with an expired session must never turn into demo data.
          if (error instanceof ApiError && error.status === 401) { active = s; pick(s); throw error; }
          last = error;
        }
      }
      throw last;
    },
    stream: (after, on) => need().stream(after, on),
    post: (path, body) => need().post(path, body),
    get fold() { return active?.fold; },
    get pairings() { return active?.pairings; },
  };
}
