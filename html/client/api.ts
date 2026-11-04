/**
 * Where the client's data comes from: one interface, two implementations. `fixtures()`
 * (fixtures/source.ts) replays a canned workspace and its records in the browser; `daemon()`
 * will talk to `autophys serve` over /api/v1 (GET /workspace, SSE /stream, POST approvals)
 * once the daemon store (src/store, src/http.rs) lands. This file holds no other network code.
 */
import type { Workspace } from "./domain.ts";
import type { Decision } from "./proposal.ts";

/** A record in the daemon's log: the SSE payload and the answer to a POST. */
export type Rec = {
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

export type Snapshot = { source: string; workspace: Workspace; gseq: number };

export interface Source {
  readonly name: string;
  /** GET /api/v1/workspace. */
  load(): Promise<Snapshot>;
  /** SSE /api/v1/stream?after=<gseq>: every record after the cursor, then live ones. Returns a stop. */
  stream(after: number, on: (r: Rec) => void): () => void;
  /** POST a decision; resolves with the record it became, rejects when the state forbids it. */
  post(path: string, body: unknown): Promise<Rec>;
}

export const approvalsPath = (investigation: string, proposal: string) => `/investigations/${investigation}/proposals/${proposal}/approvals`;

/** The daemon source. Not wired yet: the daemon store (src/store, src/http.rs) is being built by another agent. */
export function daemon(base = "/api/v1"): Source {
  throw new Error(`autophys: the daemon source (${base}) is not wired yet; use fixtures()`);
}
