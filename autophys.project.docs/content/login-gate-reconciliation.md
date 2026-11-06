# Login and HTML gate reconciliation — 2026-11-06

The normal deployment of polling guard e39415a stopped at three login tests.
The independent HTML gate reported 111 passing tests and three failures.
These source repairs preserve current account/workspace isolation and the
existing UI; they do not implement any approval-header mock.

## Causes and repairs

- The demo badge now uses the shared **Read-only** label. The login test still
  expected **Demo account**; it now checks the actual permission label.
- A cloud device must be approved by a signed-in account so the issued key has
  an account/workspace binding. The old test's direct legacy approval is correctly
  denied. The fixture now pairs through the authenticated HTTP route, explicitly
  checks that an unbound legacy pairing is denied, and verifies that a browser
  decision records the account's email in that same workspace.
- Local documents now carry the shared account control and context bootstrap.
  The local test checks that identity, read access and the document session remain
  available, while cloud sign-out remains absent.
- DOM bootstrap moved from client/context.ts into routes/context.ts.
  Context fetches moved to client/api.ts; client/context.ts holds only types.
  Both composition consumers use the route adapter. The boundary gate is unchanged.
  Two focused request tests cover fresh context reads and refused responses.
- The fake daemon now answers the session-context probe used on SSE reconnect.
  Its former 404 caused an extra error notification; the display-event expectations
  remain unchanged.
- The pending-refresh test now asserts that Store.close() publishes its cleared
  state once and that a late response cannot restore private data, notify again
  or reopen a stream. Store/controller implementation is unchanged.

## Evidence and qualification hold

The current existing executable at
~/ssd-mount/cargo-target/autophys/debug/deps/login-f50f3fb5a3535351
reproduced all three login failures. GDB stopped at the demo-label assertion
(tests/login.rs:325 before repairs) and the legacy pairing poll assertion
(tests/common/mod.rs:131). No native compilation ran.
The older ~/.cache/autophys/target login executable passes against its old
compiled code; that result is explicitly **not** current-source qualification.

Rustfmt parsed the changed Rust test, Deno fmt parsed the new TypeScript modules,
and whitespace/static boundary checks passed. Repaired tests and the complete
gates have **not** rerun: fresh owner free space is about 4.1 GiB, below the
operator's 12 GiB build/deploy floor. Do not bypass that gate or use a stale binary.
No build/install/deploy allocation, service restart, cache purge, live data
mutation or source push was performed. The existing live release remains healthy.

After the capacity owner clears fresh allocation gates and the native target's
custody is available, run from the current clean yuzuquats master:

    CARGO_TARGET_DIR=$HOME/ssd-mount/cargo-target/autophys cargo test --locked -p autophys-cli --test login
    deno test --cached-only --frozen --allow-read --config html/deno.json html/
    deno check --cached-only --frozen --config html/deno.json html/routes/index.root.ts

Then use the shared ~/.local/state/autophys/deploy.lock and normal deployment
gates to package the final clean master, retaining the polling guard and newer
same-page sign-out work. Passing focused repairs alone does not qualify the full
native workspace or authorize skipping ops/deploy.sh gates.
