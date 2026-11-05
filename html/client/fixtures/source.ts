/**
 * Test-only Source: a workspace built by deterministic simulations (fixtures.ts) plus a log
 * of canned records it replays on `stream`, then any decision posted to it. It behaves like
 * the daemon will: it checks a decision against the proposal's state and refuses it with a
 * 409-style error, numbers records globally and per investigation, and streams them.
 */
import type { Cursor, DecisionRec, Rec, Snapshot, Source } from "../api.ts";
import type { Workspace } from "../domain.ts";
import type { Decision } from "../proposal.ts";
import { applyRecord, decide } from "../records.ts";
import { buildWorkspace } from "./fixtures.ts";

/** Bench B's sine was approved before the fitting that used its data: replayed on stream. */
export const CANNED: { project: string; investigation: string; proposal: string; ts: string; decision: Decision }[] = [
  { project: "bench-oscillators", investigation: "bench-b", proposal: "p1", ts: "2026-11-02T10:05:00Z", decision: { event: "approved", by: "james", at: "Nov 2 10:05" } },
];

export type FixtureSource = Omit<Source, "post" | "stream"> & { readonly log: readonly DecisionRec[]; stream(after: Cursor, on: (r: DecisionRec) => void): () => void; post(path: string, body: unknown): Promise<DecisionRec> };

export function fixtures(canned = CANNED, workspace?: Workspace): FixtureSource {
  let base: Workspace | null = null, current: Workspace | null = null;
  const log: DecisionRec[] = [], listeners = new Set<(r: DecisionRec) => void>();
  const ready = () => {
    if (current) return current;
    current = base = workspace ?? buildWorkspace();
    for (const c of canned) append(c.project, c.investigation, c.proposal, c.decision, c.ts);
    return current;
  };
  function append(project: string, investigation: string, proposal: string, d: Decision, ts: string): DecisionRec {
    const next = decide(current!, project, investigation, proposal, d);
    if (!next) throw new Error(`409 conflict: ${d.event} does not apply to ${investigation}/${proposal}`);
    const rec: DecisionRec = {
      gseq: log.length + 1, id: `r${log.length + 1}`, investigation, seq: log.filter((r) => r.investigation === investigation).length + 1,
      kind: "proposal", ts, payload: { project, proposal, ...d },
    };
    current = next;
    log.push(rec);
    return rec;
  }
  return {
    name: "fixture",
    log,
    load: () => { ready(); return Promise.resolve<Snapshot>({ source: "fixture", workspace: base!, gseq: 0 }); },
    stream(after, on) {
      ready();
      let live = true;
      const backlog = log.filter((r) => r.gseq > Number(after));
      queueMicrotask(() => { if (live) for (const r of backlog) on(r); });
      const listener = (r: DecisionRec) => { if (live) on(r); };
      listeners.add(listener);
      return () => { live = false; listeners.delete(listener); };
    },
    post(path, body) {
      ready();
      const m = /^\/investigations\/([^/]+)\/proposals\/([^/]+)\/approvals$/.exec(path);
      if (!m) return Promise.reject(new Error(`404: ${path}`));
      const inv = current!.projects.find((p) => p.investigations.some((i) => i.id === m[1]));
      if (!inv) return Promise.reject(new Error(`404: ${path}`));
      try {
        const rec = append(inv.id, m[1], m[2], body as Decision, new Date(0).toISOString());
        queueMicrotask(() => { for (const l of listeners) l(rec); });
        return Promise.resolve(rec);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

/** Exported for tests: the workspace after replaying every record in a log from the base. */
export function replay(base: Workspace, log: readonly Rec[]): Workspace {
  return log.reduce((ws, r) => applyRecord(ws, r) ?? ws, base);
}
