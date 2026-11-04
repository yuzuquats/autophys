# tento-agent-queue

Queue a job that outlives the process that asked for it, and read what became
of it. The library is what a product links; the `tento-agent-queue` binary is
the same client as commands, for an operator or an agent working from a shell.

```rust
let queue = AgentQueue::from_env(&QueueEnv::load()?, "news-demo")?;
let enqueued = queue
  .enqueue(
    NewJob::agent("news", prompt)
      .datatype("news.summary/v1")
      .request(format!("web-{ulid}")),
  )
  .await?;
let settled = queue.wait(&enqueued.job.id, Duration::from_secs(900)).await?;
```

```sh
tento-agent-queue queue.enqueue --lane normal --form '(begin 1)' --wait
tento-agent-queue queue.list --state running
tento-agent-queue queue.show <job> | tento-agent-queue queue.cancel <job>
tento-agent-queue queue.status
```

## What runs the jobs

A [`Backend`]. Two ship:

| Backend | What it is |
| --- | --- |
| `TshBackend` | The queue this host runs. Every call is a `plugin.call` to tsh's `tsh-agent-queue` daemon through `tsh serve`; the daemon gives each attempt its own saved tsh session and owns dispatch, retries, timeouts, cancellation and result decoding. Changes arrive on serve's task stream, so nothing polls. |
| `FixtureBackend` | Runs a closure here, in this process, through the same states. A dev mode gets a working page without an agent; a test gets determinism without touching the host's queue. |

A product names neither: it holds an `AgentQueue`, and the same code runs
against either. What the product owns is the *contract* — the prompt, the
`datatype` its result must satisfy, the policy — and what the queue owns is
everything about making it happen.

## What this crate does not do

It runs nothing. There is no worker loop here, no claim, no retry timer, no
session. A product that carries those has a second queue, and two queues over
one workload disagree about what is running the moment either restarts.

It also declares no lanes. Lanes and concurrency caps are a host's
configuration, applied once by its rc (`queue.declare`); a product asks for a
lane that exists and is refused if it does not.

## Environment

| Key | Default |
| --- | --- |
| `TSH_SERVE_SOCKET` | `~/.local/share/tento/tsh-serve/serve.sock` |
| `TENTO_AGENT_QUEUE` | `default` |

Both are read through `tento-env`, so a file or store backend is seen. Embed
`QueueEnv` in a product's own config as an `EnvGroup<QueueEnv>` and one load
names every bad key at once.

## Features

- `schema` — `utoipa::ToSchema` on the job model, so a product serving these
  types generates its page's TypeScript from its own routes.
- `cli` — the `tento-agent-queue` binary. A product that links the library
  does not also link a command framework.

## Tests

`cargo test -p tento-agent-queue --all-features` covers the model against the
daemon's own record, the fixture backend's state machine, the task-stream
diff, and error mapping. Two integration tests reach outside:

```sh
# the serve contract, against tsh-web's fake serve (skipped without the key)
TENTO_AGENT_QUEUE_FAKE_SERVE=…/tsh/plugins/tsh-web/tests/fake_serve.py \
  cargo test -p tento-agent-queue --test fake_serve

# this host's real queue: enqueues a control job and waits for it
cargo test -p tento-agent-queue --test live -- --ignored --nocapture
```
