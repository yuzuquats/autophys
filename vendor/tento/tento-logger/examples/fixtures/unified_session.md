# Unified Client-Server Tracing Fixture

Target output format for the unified tracing renderer, which merges client-side
`@lona/tracing` spans with server-side LJSON into a single correlated view.

## Client LJSON

What `@lona/tracing` emits. Each root span = one LJSON line:

```jsonl
{"v":1,"ts":"2026-01-30T10:15:32.500Z","sessionId":"aaa11111-2222-3333-4444-555566667777","origin":"client","rootSpan":{"id":1,"name":"create-sheet","level":"info","durationMs":450,"location":{"file":"sheets/actions.ts","line":12},"attributes":{},"children":[{"type":"span","id":2,"name":"api-call","level":"info","durationMs":142,"location":{"file":"typed-api.ts","line":45},"attributes":{"http.method":"POST","http.path":"/api/sheets","http.status":200,"client.span_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890"},"children":[]},{"type":"event","level":"info","location":{"file":"sheets/actions.ts","line":18},"attributes":{"message":"Sheet created","sheet.id":"sheet_001"}},{"type":"span","id":3,"name":"render-update","level":"info","durationMs":15,"location":{"file":"sheets/render.ts","line":30},"attributes":{},"children":[]}]}}
{"v":1,"ts":"2026-01-30T10:15:36.800Z","sessionId":"aaa11111-2222-3333-4444-555566667777","origin":"client","rootSpan":{"id":4,"name":"save-sheet","level":"info","durationMs":500,"location":{"file":"sheets/actions.ts","line":55},"attributes":{},"children":[{"type":"span","id":5,"name":"api-call","level":"warn","durationMs":89,"location":{"file":"typed-api.ts","line":45},"attributes":{"http.method":"PUT","http.path":"/api/sheets/{id}","http.status":500,"client.span_id":"d4e5f6a7-b8c9-0123-defa-456789012345"},"children":[]},{"type":"event","level":"error","location":{"file":"sheets/actions.ts","line":62},"attributes":{"message":"Save failed, retrying..."}}]}}
```

## Server LJSON (with correlation)

Server LJSON entries with `client.span_id` linking to client api-call spans:

```jsonl
{"v":1,"ts":"2026-01-30T10:15:32.200Z","sessionId":"bbb11111-2222-3333-4444-555566667777","rootSpan":{"id":100,"name":"http_request","level":"info","durationMs":142,"location":{"file":"loaf/src/routes/api.rs","line":50},"attributes":{"http.method":"POST","http.target":"/api/sheets","http.status_code":200,"http.host":"app.lona.so","http.client_ip":"203.0.113.42","user.connecting_ip":"203.0.113.42","user.id":"alice","version.dev_flag":"beta","client.span_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890"},"children":[{"type":"span","id":101,"name":"auth_check","level":"info","durationMs":8,"location":{"file":"loaf/src/middleware/auth.rs","line":22},"attributes":{},"children":[]},{"type":"span","id":102,"name":"db_query","level":"info","durationMs":45,"location":{"file":"loaf/src/db/sheets.rs","line":88},"attributes":{},"children":[{"type":"event","level":"info","location":{"file":"loaf/src/db/pool.rs","line":15},"attributes":{"message":"Acquired connection from pool"}}]},{"type":"event","level":"info","location":{"file":"loaf/src/routes/api.rs","line":75},"attributes":{"message":"Sheet created successfully"}}]}}
{"v":1,"ts":"2026-01-30T10:15:36.400Z","sessionId":"bbb11111-2222-3333-4444-555566667777","rootSpan":{"id":200,"name":"http_request","level":"error","durationMs":89,"location":{"file":"loaf/src/routes/api.rs","line":50},"attributes":{"http.method":"PUT","http.target":"/api/sheets/{id}","http.status_code":500,"http.host":"app.lona.so","user.id":"charli","version.dev_flag":"prod","client.span_id":"d4e5f6a7-b8c9-0123-defa-456789012345"},"children":[{"type":"span","id":201,"name":"db_query","level":"info","durationMs":67,"location":{"file":"loaf/src/db/sheets.rs","line":88},"attributes":{},"children":[{"type":"event","level":"error","location":{"file":"loaf/src/db/sheets.rs","line":102},"attributes":{"message":"Database constraint violation"}}]},{"type":"event","level":"error","location":{"file":"loaf/src/routes/api.rs","line":80},"attributes":{"exception.trace_json":"{\"message\":\"duplicate key value violates unique constraint\",\"sources\":[],\"frames\":[],\"filtered_range\":null}"}}]}}
```

## Unified Rendered Output

The renderer merges client and server LJSON by matching `client.span_id`.
Server span trees are grafted as children of the matching client `api-call`
span. Grafted server children use normal tree depth indentation (not the
10-space request padding used in standalone server rendering).

```
 │  450ms │ 10:15:32.050 │                       │        │ C │ create-sheet
 │  142ms │ 10:15:32.058 │ ↗        203.0.113.42 │  alice │ S │ ├ 200 POST B app.lona.so    /api/sheets
 │    8ms │              │                       │        │ S │ │ ├ auth_check
 │   45ms │              │                       │        │ S │ │ ├ db_query
 │        │              │                       │        │ S │ │ │ └ Acquired connection from pool
 │        │              │                       │        │ S │ │ └ Sheet created successfully
 │        │              │                       │        │ C │ │ Sheet created
 │   15ms │              │                       │        │ C │ └ render-update

 │  500ms │ 10:15:36.300 │                       │        │ C │ save-sheet
e│   89ms │ 10:15:36.311 │                       │ charli │ S │ ├ 500 PUT  P app.lona.so    /api/sheets/{id}
 │   67ms │              │                       │        │ S │ │ ├ db_query
e│        │              │                       │        │ S │ │ │ └ Database constraint violation
 │        │              │                       │        │ S │ │ ┌───┄
 │        │              │                       │        │ S │ │ │ Panic: duplicate key value violates unique constraint
 │        │              │                       │        │ S │ │ └───┄
e│        │              │                       │        │ C │ └ Save failed, retrying...
```

## Column Layout

```
L│ Elapsed│  Timestamp   │          IP           │  User  │ O │ Details
─┼────────┼──────────────┼───────────────────────┼────────┼───┼─────────
 │  450ms │ 10:15:32.050 │                       │        │ C │ create-sheet
 │  142ms │ 10:15:32.058 │ ↗        203.0.113.42 │  alice │ S │ ├ 200 POST...
 │    8ms │              │                       │        │ S │ │ ├ ...
                                                              │
1         10             25                      49      57  61
```

Pipe positions (0-indexed character positions):
- Pipe 1 (level│elapsed): position 1
- Pipe 2 (elapsed│timestamp): position 10
- Pipe 3 (timestamp│IP): position 25
- Pipe 4 (IP│user): position 49
- Pipe 5 (user│origin): position 58
- Pipe 6 (origin│details): position 62

Column widths:

| Column    | Width | Format                      | Example              |
|-----------|-------|-----------------------------|----------------------|
| Level     | 1     | `e` red, `w` yellow, ` `    | `e`, `w`, ` `        |
| Elapsed   | 8     | 7 right-aligned + space     | `  142ms `           |
| Timestamp | 14    | space + HH:MM:SS.mmm + sp   | ` 10:15:32.058 `    |
| IP        | 23    | sp + CF(1) + IP(20) + sp    | ` ↗        203.0.113.42 ` |
| User      | 8     | sp + right-align(6) + sp    | `  alice `           |
| Origin    | 3     | sp + `C`/`S` + sp           | ` C `, ` S `         |
| Details   | var   | guidelines + content        |                      |

## Design Notes

1. **Same columns everywhere**: Client and server lines share identical column
   widths. Client spans have blank IP/User columns. Default (non-request) server
   spans have blank IP/User columns. Only server request root spans populate
   IP/User.

2. **Timestamp semantics**: Root spans show start time (`ts - duration_ms`).
   Child spans/events show blank (14 spaces). The timestamp enables chronological
   interleaving of independent client and server root entries.

3. **Grafting**: When `render_unified()` finds a server LJSON entry whose
   `client.span_id` matches a client `api-call` span, the server request tree
   is grafted into the client tree at the api-call's position. The grafted
   server root shows request details (status, method, host, path) on the
   client guideline line. Server children render with normal tree depth
   indentation, prefixed by the client's continuation guidelines (`graft_prefix`).

4. **Exception box**: Rendered within the Details column, after the tree
   guideline `│`. The box uses `┌───┄` / `└───┄` delimiters. In grafted
   contexts, the box sits at the client guideline level (using `graft_prefix`
   instead of the 10-space request padding).

5. **Ungrafted entries**: Server entries without `client.span_id` render
   standalone via `render_entry()` — backwards compatible with non-instrumented
   code.

6. **Origin column position**: Origin (`C`/`S`) is placed right before the
   details column so it's visually adjacent to the log content. Level
   (`e`/`w`/` `) remains at the far left for quick error scanning.
