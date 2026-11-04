# Node logging (fleet data buckets)

How every fleet node records its **logs, traces, and metrics** to local disk in
one uniform form, and how a control-pane pulls and caches them — declared,
rolled, retained, and synced independently of the app that produces them.

## The one idea: logging is a *shape* of a node's buckets

There is no separate logging stack, metrics stack, and tracing stack. They are the
same problem — **time-ordered records a node emits** — viewed at different
*shapes*. A node writes them into **buckets** on its own disk; a control-pane
pulls the segments it wants into an edge cache; renderers interpret by shape.

| Signal | Shape (`shape_tag`) | Row type | Producer |
| --- | --- | --- | --- |
| logs + request traces + HTTP access | `span-tree/v1` | [`SpanRow`] | Rust `tracing` spans/events (hello, loaf, admin, recorder…) |
| metrics / gauges | `cell/v1` | [`CellRow`] | any point series (lona `SheetCellRecord`) |
| host cpu/ram/disk | `host-metrics/v1` | cell-like | host-health sampler |
| *future* | `<shape>/vN` | `T: SeriesRow` | slot in by `shape_tag` + a renderer |

A **bucket** is just a directory with a `meta.json`. The crate fan-out:

| Layer | Crate | Owns |
| --- | --- | --- |
| Bucket model | `tento-buckets` | dir layout, `meta.json`, retention, discovery, janitor |
| Time series | `tento-timeseries` | `TimeSeriesStore<R>`, ljson↔parquet rollups, range reads |
| Span schema | `tento-logger/spans` | `SpanRow`, `recompose`, `SHAPE_TAG` |
| Producer | `tento-logger` (`buckets` feat) | `SpanBucketSink`, `LoggerConfig.span_bucket`, `SpanSample` |
| Transport | `tento-host` | mTLS server + client `mirror`/`fetch_fragment`/`refresh_manifest`, `rollup_shape` |
| Host agent | `host-health.node` | serves buckets over mTLS + hourly janitor timer |
| Control-pane | `lona-console` | `pull` + the TUI pull / cache-op worker |
| Read | `tento-tui-*`, `inspect-traces.sh` | render by shape (graph / recomposed tree) |

## Structure (on disk)

```text
  <root>/<host>/<node-path…>/<bucket>/
    meta.json            {"shape_tag": "...", "retention": {...}?}
    samples/<YYYY-MM-DD>.ljson   ← hot, append-only, one JSON record per line
    daily/<YYYY-MM-DD>.parquet   ← rolled from a completed day (immutable)
    weekly/<%G-W%V>.parquet      ← rolled from a completed ISO week (immutable)
    .manifest.json               ← cache-side only (see "Sync")

  segment address:  <host> / <node-path> / <bucket> / <fragment>
                    rwc-03 / loaf/web    / spans    / daily/2026-08-01.parquet
```

- **`<host>` is the top segment on BOTH the producer and the cache**, so the two
  trees are structurally identical — a host's bucket root is exactly a sub-tree of
  the pane's cache. One function, [`bucket_dir`]`(root, host, node, name)`, serves
  both sides, and `rsync -a host:<root>/ pane:<edge-cache>/` is a drop-in
  alternative to the mTLS pull.
- The **node-path** between `<host>` and the bucket may be **nested** (`loaf/web`),
  so discovery is a recursive walk for `meta.json` ([`BucketRegistry`]), never a
  fixed-depth scan. A dir with `meta.json` *is* a bucket; its `samples/daily/weekly`
  children are data, not node-path.
- **Roots**: `default_buckets_root()` = `$TENTO_BUCKETS_ROOT` → `~/.tento/buckets`;
  `host_id()` = `$TENTO_HOST_ID` → hostname. The host id MUST match the recorder's
  fleet-id or the trees won't align.

## Producer: `tracing` → spans, no new hooks

Apps keep every `tracing::…` call. With the `buckets` feature and a
`LoggerConfig.span_bucket`, a [`SpanBucketSink`] taps the *existing* capture
(`SlogLayer` → `TraceOp` stream) and appends rows — no new instrumentation.

```text
  #[instrument] · info_span!() · event!()      (app, unchanged)
        ▼  SlogLayer → TraceOp{Open,Field,Event,Close}
  SpanBucketSink            mints a stable span_id at Open (tracing's u64 is
   live: u64 → {span_id,trace_id,parent_id}    recycled per process), inherits
   Close ⇒ SpanRow(kind="span")               trace_id (a root sets trace=self),
   Event ⇒ SpanRow(kind="event")              evicts at Close
        ▼  append (incremental, one row per span/event)
  TimeSeriesStore<SpanRow> → samples/<today>.ljson
```

`(session_id, span_id)` is globally unique; rows stream out of order and
[`recompose`] rebuilds the trees. `attributes` is a single opaque JSON column
(HTTP/user fields ride there, not promoted to typed columns). **Sampling**:
`SpanSample::Rate { keep_rate }` keeps/drops a *whole trace* (decided at its root;
errors always kept) to bound volume; `SpanSample::All` is the default.

## Rollups + lifecycle

`samples/*.ljson` is the only mutable file. Everything else is produced by
**rolling** completed periods forward, then **pruning** by age. Producers only
ever `append`; rolling and pruning are owned host-side by a **janitor**, decoupled
from app liveness (an exited app's hot ljson still rolls up).

```text
  append            roll (period complete)           prune (past retention)
  samples/<today>.ljson ─► daily/<date>.parquet ─► weekly/<wk>.parquet ─► deleted
        │ never rolled/pruned while "today"   │ keep_daily_days        │ keep_weekly_weeks
        └ keep_hot_days (completed ljson)     ▼ deleted
```

- **Rollup** = [`TimeSeriesStore::rollup`] (`rollup_daily` then `rollup_weekly`):
  idempotent, self-healing, **today is always exempt**. Shape-erased at the janitor
  level via [`rollup_shape`]`(shape_tag, dir)` which dispatches `span-tree/v1`→
  `SpanRow`, `cell/v1`→`CellRow`; unknown shape → skip.
- **Retention** = [`RetentionPolicy`]`{keep_hot_days, keep_daily_days,
  keep_weekly_weeks}` in `meta.json` (`#[serde(default)]`, so old `{"shape_tag":…}`
  stays valid). Per-shape defaults: span-tree hot 2d / daily 30d / weekly 26w;
  cell & host-metrics hot 7d / daily 90d / weekly 104w; **unknown → keep all**.
  Prune is **file-level**, keyed on the file-name date (not mtime, so backfill
  prunes by logical date), and **never deletes today's hot file**. Order is always
  **rollup before prune**.
- **Node-deletion GC**: the janitor removes bucket dirs whose node-path is no
  longer a live node — **opt-in**, grace-guarded (a node briefly absent, or a
  brand-new bucket, is protected), only after a successful snapshot.
- **Who runs it**: `host-health.node`'s agent runs `Janitor::sweep` on an hourly
  timer; `host.health janitor.sweep` triggers it manually.

## Serving: the host agent

Each onboarded host runs an mTLS bucket agent (spawned by `host-health.node`'s
`spawn_bucket_agent`, gated on `TENTO_HOST_TLS_*`, bound `0.0.0.0:9443` — never
`8443`). It serves the host's own `<root>/<host>/` subtree; new producer buckets
appear via the recursive `meta.json` walk **without a restart**.

| Route (all `GET`, mTLS) | Returns |
| --- | --- |
| `/buckets` | `[{node, name, shape_tag}]` discovery |
| `/buckets/<node…>/<name>/manifest` | `Manifest {shape_tag, files: [FragmentFile{path, bytes}]}` |
| `/buckets/<node…>/<name>/file/<rel…>` | one fragment's raw bytes (traversal-checked) |

The wire is **host-implicit**: the agent reports `(node, name)` for its own host;
the recorder prepends the host it queried.

## Sync on clients (the edge cache)

The control-pane (recorder) pulls segments into
`<inventory>/.edge-cache/<host>/<node-path>/<bucket>/` — **byte-identical** to the
producer layout, so a `TimeSeriesStore::new(<cache dir>)` reads it like any local
store, and rsync is interchangeable with the pull.

- **Full pull** — `lona-console pull --fleet-id <host>` (or `--all`): discover
  buckets, then [`mirror`] each — **skip** immutable parquet already present at the
  same size, **re-fetch** the growing hot ljson. Freshness-guarded by a
  `.last-pull` marker. The fleet shell fires the same pull off the render
  thread via the `(on-select <lambda>)` reactor (a `(lambda (host edge-cache)
  …)` in the scene preset that `(exec)`s `lona-console-pull` after a `(stale?)`
  check) when you select a host.
- **On-demand segment paging** — the cache becomes a *working set*, not a full
  mirror. (The `fleet.health cache` debug pane that exercised this has been
  retired; the segment-paging machinery still exists in `tento-host` for
  future tooling.)
- **Retention means a previously-cached segment can vanish upstream** — the cache
  keeps its copy (it is the archive). Immutable parquet is safe to cache forever;
  the hot `samples/<today>.ljson` must be re-pulled.

## Reading

Renderers dispatch by `shape_tag` over the edge cache:
- `cell/v1` → a sparkline history graph (`tento-tui-data` `GraphPane` over
  `EdgeCacheDataset`).
- `span-tree/v1` → `recompose` the rows into trees: `tento-tui-data` `LogsPane`
  (and the cache-inventory pane for segment management), or `inspect-traces.sh`
  (duckdb recompose over the cached ljson + parquet).

Every consumer reuses `recompose` — it is the one tree-assembly; do not
re-implement it.

---

[`SpanRow`]: ../../tento-logger/spans/src/lib.rs
[`CellRow`]: ../../tento-timeseries/src/cell.rs
[`recompose`]: ../../tento-logger/spans/src/lib.rs
[`SpanBucketSink`]: ../../tento-logger/src/subscribers/span_bucket.rs
[`TimeSeriesStore::rollup`]: ../../tento-timeseries/src/store.rs
[`BucketRegistry`]: ../src/lib.rs
[`RetentionPolicy`]: ../src/lib.rs
[`bucket_dir`]: ../src/lib.rs
[`rollup_shape`]: ../../tento-host/src/shapes.rs
[`mirror`]: ../../tento-host/src/client.rs
[`fetch_fragment`]: ../../tento-host/src/client.rs
[`refresh_manifest`]: ../../tento-host/src/client.rs
