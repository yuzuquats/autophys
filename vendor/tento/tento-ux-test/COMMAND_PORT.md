# Call a private administration CLI from the runner

`HostPort::from_commands(Config)` selects a command-backed port explicitly.
The existing setup, browser host bridge and verb lint use that same port. It
never falls back to an in-process loop or HTTP when a command fails. Mounting
and listing its vocabulary are offline; `preflight_commands()` checks every
configured operation before run setup, and direct calls preflight on first use.

The initial implementation supports **read operations with non-sensitive
results only**. Mutating or sensitive bindings are rejected at configuration
load. It is transport qualification for an available status endpoint, not a
fixture migration or permission to run destructive tests. In particular it
does not yet implement reservations, browser routing/generation fences,
durable detached ownership, credential recovery or protected result storage.

A trusted deployment file, separate from test parameters, declares the target:

```json
{
  "schema": "ux.admin-command/v1",
  "wire_schema": "example.admin/v1",
  "product": "example",
  "artifact": "expected-artifact-v1",
  "expected": {
    "instance_id": "test-instance",
    "profile": "expected-profile",
    "database": "dedicated-test"
  },
  "hello": {
    "transport": "ssh",
    "host": "test-host",
    "program": "/opt/example/bin/admin",
    "args": ["live", "hello", "--target-file", "/srv/example/admin-target.json", "--json"]
  },
  "call": {
    "transport": "ssh",
    "host": "test-host",
    "program": "/opt/example/bin/admin",
    "args": ["live", "call", "--target-file", "/srv/example/admin-target.json", "--json"]
  },
  "timeout_ms": 30000,
  "bindings": {
    "status": {
      "operation": "runtime.status",
      "version": 1,
      "effect": "read",
      "sensitive": false,
      "params": {},
      "result": "object"
    }
  }
}
```

`transport: local` omits `host` and executes the absolute program directly.
SSH uses batch mode, no TTY, a connection deadline and strict host verification.
An optional absolute `known_hosts` path selects an explicitly provisioned trust
file; otherwise SSH uses its existing trust configuration. Never construct that
file by automatically accepting a network scan. Fixed remote argv words are
shell-quoted; no test value is inserted into argv or remote shell text.

`expected` is a nonempty map of independently configured string identity fields.
Hello must return exactly these keys plus a non-nil UUID `boot_id`. Artifact,
wire schema, product, readiness and all operation/version/effect declarations
must match before any call. The resulting identity is pinned for the port's
lifetime; it is not refreshed automatically after a restart.

`params` declares the exact required field set and each field's JSON type:
`null`, `boolean`, `number`, `string`, `array` or `object`. `result` declares
the result type. This slice does not transform field names, project nested
results, validate nested schemas or aggregate pages. It preserves JSON values,
including explicit null, without the shell capability's stdout/object wrapping.

The executable accepts the versioned hello/call/reply envelope implemented by
the private channel. Schema/product values are configuration, not Rust product
imports. Calls get fresh UUID request IDs and send their expected identity,
operation/version, params and timeout as JSON stdin. The process deadline adds
twenty seconds for SSH connection, CLI hello, POST transport and scheduling
overhead to the bounded operation timeout.
There is one active call per port and no waiting call queue. Stdin, stdout and
config files are capped at 1 MiB; stdout is bounded while reading, concurrently
with stdin writes. Stderr is discarded. Diagnostics never include either pipe,
raw params or backend error text. No nonzero exit is accepted as success.

Lost, malformed, mismatched, oversized or timed-out replies are unknown outcomes.
They return the request ID and poison the port. Caller cancellation after
dispatch also poisons it. Terminating/reaping the local child is not proof that
remote work stopped. A valid not-started refusal is a known failure; even if
marked retryable it is not retried. A changed identity requires explicit recovery.
There is no durable request journal in this read-only slice.

Recovery here means constructing a new explicitly configured `HostPort`; there
is no in-place recovery API. Empty stdout with a nonzero exit is conservatively
unknown even when the specific CLI failed before dispatch: the generic runner
cannot distinguish that from an SSH/executable failure after a remote effect.

Mount it with the existing environment:

```rust,ignore
let config = tento_ux_test::command_port::Config::load(config_path)?;
let port = tento_ux_test::HostPort::from_commands(config)?;
let ctx = tento_ux_test::UxTestCtx::new(env, port);
tento_ux_test::scripts::scripts(ctx).run().await;
```

The standalone `admin_command` example exercises the same port without a product
boot or browser: `admin_command /absolute/config.json status < params.json`.
Only configured non-sensitive results are printed. It is a qualification tool,
not an installed acceptance runner or deployment configuration.

Administration transport does not choose completion authority. The constructor
keeps the runner-local sink; page-origin authority remains a separate explicit
choice. The new paginated/terminal-watermark reporting contract is still pending.
The independently extracted 0.2 harness in `workspace/ux-test` has not adopted
this port; do not claim its older shell/HTTP capabilities satisfy this protocol.
