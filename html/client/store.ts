/**
 * The client's only data state: the snapshot a Source loaded, with every streamed or posted
 * record applied in gseq order. Readers call `snapshot()` and `subscribe()`; nothing else
 * mutates it.
 */
import type { Rec, Snapshot, Source } from "./api.ts";
import { applyRecord } from "./records.ts";

export class Store {
  private snap: Snapshot | null = null;
  private stop: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private subs = new Set<() => void>();
  /** Records applied after the load, in order. */
  readonly applied: Rec[] = [];

  constructor(readonly source: Source) {}

  /** Load once, then follow the stream. */
  start(): Promise<void> {
    return this.starting ??= this.source.load().then((snap) => {
      this.snap = snap;
      this.stop = this.source.stream(snap.gseq, (r) => this.apply(r));
      this.notify();
    });
  }

  snapshot(): Snapshot | null {
    return this.snap;
  }

  /** Apply one record; one already applied (by gseq) is ignored, so a POST's answer and its stream echo apply once. */
  apply(r: Rec): void {
    if (!this.snap || r.gseq <= this.snap.gseq) return;
    const ws = applyRecord(this.snap.workspace, r);
    this.snap = { ...this.snap, workspace: ws ?? this.snap.workspace, gseq: r.gseq };
    this.applied.push(r);
    this.notify();
  }

  async post(path: string, body: unknown): Promise<Rec> {
    const r = await this.source.post(path, body);
    this.apply(r);
    return r;
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  close(): void {
    this.stop?.();
    this.stop = null;
  }

  private notify(): void {
    for (const fn of this.subs) fn();
  }
}
