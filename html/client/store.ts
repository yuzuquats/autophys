/**
 * The client's only data state: the snapshot a Source loaded, with every streamed or posted
 * record applied, and the devices waiting to pair. Readers call `snapshot()` and
 * `subscribe()`; nothing else mutates it.
 */
import type { Rec, Snapshot, Source } from "./api.ts";
import { applyRecord } from "./records.ts";

export class Store {
  private snap: Snapshot | null = null;
  private refreshing: Promise<void> | null = null;
  private closed = false;
  private stop: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private subs = new Set<() => void>();
  /** Source failures are rendered even when initial load never completed. */
  error: string | null = null;
  private stopErrors?: () => void;
  private seen = new Set<string>();
  /** Records applied after the load, in arrival order. */
  readonly applied: Rec[] = [];

  constructor(readonly source: Source) {
    this.stopErrors = source.onError?.((error) => { this.error = error.message; this.notify(); });
  }

  /** Load once, then follow the stream. */
  start(): Promise<void> {
    return this.starting ??= this.source.load().then((snap) => {
      this.snap = snap;
      this.stop = this.follow(snap.gseq);
      this.notify();
      void this.refreshPairings();
    }).catch((error) => {
      this.error ??= String(error?.message ?? error);
      this.notify();
      throw error;
    });
  }

  /** A project can register before it emits an investigation record. Pause this
   * store's own stream while replacing its snapshot, then resume from that
   * snapshot's opaque collection cursor; failed reads retain the last records. */
  refreshWorkspace(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.refreshing ??= (async () => {
      this.stop?.(); this.stop = null;
      try {
        const next = await this.source.load();
        if (this.closed) return;
        this.snap = { ...next, pairings: this.snap?.pairings ?? next.pairings };
        this.error = null;
        this.starting = Promise.resolve();
      } catch (error) {
        this.error = String((error as Error)?.message ?? error);
      } finally {
        if (!this.closed && this.snap) this.stop = this.follow(this.snap.gseq);
        if (!this.closed) this.notify();
      }
    })().finally(() => { this.refreshing = null; });
  }

  /** Presentation/reference updates do not append records or advance a cursor. */
  private follow(cursor: Snapshot["gseq"]): () => void {
    return this.source.stream(cursor, (r) => this.apply(r), (workspace) => {
      if (this.closed || !this.snap) return;
      this.snap = { ...this.snap, workspace };
      this.notify();
    });
  }

  snapshot(): Snapshot | null {
    return this.snap;
  }

  /**
   * Apply one record. A record is applied once (by investigation and record id), so a POST's answer and its stream
   * echo count once. In-order sources skip anything at or below the cursor; a source with its
   * own fold takes records in any order (its fold is idempotent) and may hand one back again
   * to re-derive.
   */
  apply(r: Rec): void {
    if (!this.snap) return;
    const fold = this.source.fold;
    if (!fold && Number(r.gseq) <= Number(this.snap.gseq)) return;
    const key = `${r.investigation}/${r.id}`;
    const first = !this.seen.has(key);
    const ws = fold ? fold(this.snap.workspace, r) : applyRecord(this.snap.workspace, r);
    if (!first && !ws) return;
    this.seen.add(key);
    const gseq = typeof r.gseq === "string" ? r.gseq
      : typeof this.snap.gseq === "string" ? this.snap.gseq : Math.max(this.snap.gseq, r.gseq);
    this.snap = { ...this.snap, workspace: ws ?? this.snap.workspace, gseq };
    if (first) this.applied.push(r);
    this.notify();
  }

  async post(path: string, body: unknown): Promise<Rec> {
    const r = await this.source.post(path, body);
    this.apply(r);
    return r;
  }

  /** Re-read the devices waiting to pair; a failed read keeps the last list. */
  async refreshPairings(): Promise<void> {
    const pairings = this.source.pairings;
    if (!pairings || !this.snap) return;
    try {
      const list = await pairings.list();
      if (JSON.stringify(list) === JSON.stringify(this.snap.pairings ?? [])) return;
      this.snap = { ...this.snap, pairings: list };
      this.notify();
    } catch { /* keep what we had */ }
  }

  /** Approve or deny a pairing, then re-read the list. Rejects with the source error. */
  async decidePairing(code: string, approve: boolean): Promise<void> {
    if (!this.source.pairings) throw new Error("this source has no pairings");
    await this.source.pairings.decide(code, approve);
    await this.refreshPairings();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  close(): void {
    this.closed = true;
    this.stop?.();
    this.stop = null;
    this.stopErrors?.();
  }

  private notify(): void {
    for (const fn of this.subs) fn();
  }
}
