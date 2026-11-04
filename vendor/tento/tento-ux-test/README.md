# tento-ux-test

The UX-test harness: the spec model, session store, orchestration and the
`ux-test` command group a host mounts (lona's `mono ux-test`).

## Agent-driven `--auto` (`UX_AGENT_LANE`)

A spec with a `manual: true` step stops the headless runner at that step. On a
host that names an agent lane, `ux-test run --auto` hands such a spec to ONE
agent job instead, enqueued through `tento-agent-queue` (tsh's
`tsh-agent-queue` runs it: one saved tsh session per attempt). Without the
variable, or for a spec with nothing manual, the run is exactly the headless
one. Source: `src/agent.rs`; the agent's brief is `src/agent_prompt.md`
(checked in, `include_str!`).

What one run does:

1. Resolves everything below BEFORE setup (a host that cannot drive agents
   fails without creating a user), then runs setup and creates the session and
   prints `{sessionId, url}` exactly as `--no-wait` does.
2. Runs the Google and/or Microsoft sign-in pre-step, when configured (below), and
   only then enqueues one job: kind `agent`, the lane, `max_attempts` 1,
   `timeout_ms` = the spec's `timeout`, producer `tento-ux-test`, request =
   the session id, and `payload.agent.cwd` = the run's absolute agent dir —
   the lane's working directory, so everything the agent writes and runs is
   inside it. The harness and its permissions stay the queue's declaration.
   The prompt names the spec, the run's `spec.yaml` snapshot,
   the session, the launch URL, the DevTools URL, the run dir and the work dir
   (`<run dir>/agent/`, where the prompt is also kept as `prompt.md`).
3. Launches the browser — this process owns it — once the queue reports the job
   running, with the signed-in profile and DevTools on a loopback port. It is
   closed (SIGTERM, then SIGKILL) however the run ends. Before every launch on
   the profile (the sign-in pre-step's too) the profile's session-restore state
   is removed — `Default/Sessions/*` and `Default/{Current,Last} {Session,Tabs}`,
   nothing else: `Cookies`, `Login Data`, `Preferences` and `Local State` stay —
   so no tab from an earlier run comes back (a stale `rc--calendar` tab can
   consume a spec's single-use promo cookie). The browser starts on
   `about:blank`; once it answers (and the harness sink, below, is
   intercepting) the launch URL is opened in a new tab and every other page is
   closed, so the agent finds exactly one tab. A launch URL that cannot be
   opened ends the run `unfinished`, blocker `browser-launch`.
4. Waits for the in-page harness to complete the session and for the job to
   end, bounded by the spec timeout + 60 s. A job still queued after
   `UX_AGENT_QUEUE_WAIT_SECS`, or running past the budget, is cancelled.
5. A completed session goes through the same finalize path as
   `ux-test finalize --by agent` (snapshot, teardown, verification, ledger).
   A run the agent never completed still tears down, writes
   `verification.json` = `not_run` and records `unfinished` with a blocker —
   the agent's own `RESULT … unfinished <blocker>` when it gave one.
6. Writes `agent.json` (`ux-test.agent-run/v1`: queue, lane, job id, final
   state, attempt sessions, how the drive ended, whether this process cancelled
   the job, the agent's `RESULT` line, the verification outcome, a one-line
   reason) and prints `agent-driven run: <reason>`.

It passes only when `verification.json` reads `passed`; anything else exits
non-zero with `agent-driven run did not pass: <reason>`. In a batch
(`--all` / `--group`) such specs are run, not skipped, and count as passed or
failed — never partial.

| Variable | Meaning |
| --- | --- |
| `UX_AGENT_LANE` | The lane to enqueue into. Set ⇒ agent driver for specs with a manual step. |
| `TENTO_AGENT_QUEUE` | The queue (default `default`). |
| `TSH_SERVE_SOCKET` | `tsh serve`'s socket (default `~/.local/share/tento/tsh-serve/serve.sock`). |
| `PUPPETEER_EXECUTABLE_PATH` | The browser binary. Required. A binary named `*headless-shell*` runs as is; any other gets `--headless=new`. |
| `UX_USER_DATA_DIR` | The signed-in browser profile. Unset ⇒ a fresh profile in the work dir (no sign-in). Required with `UX_GOOGLE_PASSWORD_FILE`: a signed-in profile must not live in the agent's workspace. |
| `UX_AGENT_QUEUE_WAIT_SECS` | How long a job may wait to start. Default: the spec's timeout. |
| `UX_GOOGLE_PASSWORD_FILE` | A file holding the Google password of `UX_GOOGLE_ACCOUNT`. Set ⇒ the Google sign-in pre-step (below) runs. Unset ⇒ no pre-step, exactly as before. |
| `UX_GOOGLE_ACCOUNT` | The Google account that password belongs to. Required with `UX_GOOGLE_PASSWORD_FILE`. |
| `UX_MICROSOFT_PASSWORD_FILE` | A file holding the Microsoft password of `UX_MICROSOFT_ACCOUNT`. Set ⇒ the Microsoft sign-in pre-step (below) runs, after Google's when both are set, for a spec that lists `microsoft` in `signin_providers:` or, without that field, whose manual steps (id, instruction or reason) name Microsoft or Outlook; any other spec skips it, so its timeout cannot cancel a Google-only run (see [Which pre-steps a spec gets](#which-pre-steps-a-spec-gets-signin_providers)). Unset ⇒ no pre-step, exactly as before. Also requires `UX_USER_DATA_DIR`. |
| `UX_MICROSOFT_ACCOUNT` | The Microsoft account that password belongs to. Required with `UX_MICROSOFT_PASSWORD_FILE`. |

The lane is the host's, declared once in its tsh rc; ux-test never declares
one. ONE browser profile means the lane runs one job at a time, which is what
serialises concurrent specs. The one file lock is the sign-in pre-step's
(`<profile>/ux-test.lock`, below), because that pre-step runs before its job
is enqueued. Which harness runs the job is the
queue's `:agent` declaration; the job adds only its workspace (`cwd`) and the
runner's `deno.json` (`TSH_WORKSPACE_DENO_CONFIG` in the lane env). The shipped
default (`acp` / `claude` / `permissions plan`) is read-only and cannot drive a
browser, so declare one of these.

**Claude (ACP), the unattended default.** On an ACP lane every permission ask
the agent raises PARKS until something answers it — ux-test answers none, and
nobody is watching an unattended lane — so the lane must name a rule that
answers them. `:permissions allow-workspace` names tsh's `allow-workspace` rule,
recorded as `rule:acp.tsh/allow-workspace`. It ships with tsh, not with this
crate, and where it lives differs between tsh lines (check the installed tsh's
lane presets and plugins, not a source path). It allows file tools inside the
workspace, `ls`/`cat`/`mkdir` inside it, `curl` to loopback, and
`deno run --cached-only --config <that deno.json>` with network only to
loopback and reads/writes only inside the workspace; everything else is denied
with the ask's one-shot reject, and the agent is told why. On a tsh whose
install lacks the rule, or a lane that names none, nothing answers: every ask
parks, and the run ends only when the spec's timeout cancels the job.

```clojure
(@import "tsh-agent-queue" :as "agent-queue")
(agent-queue.queue.declare "ux-test"
  :max-running 1
  :default-lane "ux-browser"
  :lanes [{:id "ux-browser" :max-running 1}]
  :agent {:handler "acp" :agent "claude" :cmd "claude-agent-acp"
          :permissions "allow-workspace"})
```

**Codex.** A `lisp`-handler lane on tsh's bundled `presets/lanes/codex.tsh`
(`:script`, the absolute path inside the installed tsh bundle). Codex's own sandbox
enforces the workspace (writable root = the lane cwd) and runs commands in it
without asking; its network is ONE switch, all or nothing, so reaching DevTools
on loopback needs `:network "on"`, which also opens every other host. There is
no rule for Codex's escalation asks: one still parks.

```clojure
(agent-queue.queue.declare "ux-test"
  :max-running 1
  :default-lane "ux-browser"
  :lanes [{:id "ux-browser" :max-running 1}]
  :agent {:handler "lisp" :agent "codex" :cmd "codex app-server --stdio"
          :script "<tsh bundle>/presets/lanes/codex.tsh"
          :permissions "allow-workspace" :network "on"})
```

Either way, set `UX_AGENT_LANE=ux-browser TENTO_AGENT_QUEUE=ux-test` in the
runner's environment. The agent's scripts import `npm:puppeteer-core@22.7.1`
from the runner's cache (`deno.land/x` imports read outside the workspace and
are denied).

```sh
# the real launcher against a real browser (ignored by default)
PUPPETEER_EXECUTABLE_PATH=… cargo test -p tento-ux-test -- --ignored real_browser
```

### Harness-post sink (remote targets)

The in-page harness posts `/_/ux-test/logs` and `/_/ux-test/complete` to the
page origin. Under the built-in `local` profile that is this host's daemon, whose
store is the run dir. Under every named profile (`--env rc`, …) it is a remote
server whose store never heard of the session: before this, the agent's
`__lonaUxComplete("success")` was lost there and the run ended
`agent-no-completion` (c37, 2026-09-26). For exactly the profiles the headless
runner sinks for (`headless::harness_sink_for`), ux-test starts
`harness-sink.deno.ts` (source: `tento-ux-runner/`, with its one import
`lib/harness-sink.ts` — the same `sinkHarnessPost` the headless runner uses —
both embedded and written to `<run dir>/harness-sink/`) on the agent's browser
before it opens the launch URL:

- `deno run --no-prompt --cached-only --no-config --no-lock`, network only to
  the DevTools port, reads only `session.json`, writes only `session.json`,
  `logs.ljson` and `complete.json` of the run dir.
- `Fetch.enable` on the browser target with the one pattern `*/_/ux-test/*`:
  every tab, navigation (OAuth round trips) and service worker is covered, and
  no other request — Google's, Stripe's, the app's own — is ever paused.
- The app's hosts are the corpus manifest's `domains` plus the launch URL's
  host and its subdomains (so a corpus that declares no domains is scoped to
  the app it launched, not to every host).
- A POST to one of the two paths, on an app host, carrying THIS session's id,
  is answered 200 in the browser and written to the run dir. Anything else is
  continued untouched: no header, URL or body is changed.
- It is taken — and its reply, or a preflight's, carries CORS headers (the
  page's own `Origin` echoed, with credentials) — only from a page on an app
  host. A harness request whose `Origin` is another site, or opaque (`null`),
  is refused 403 with no CORS headers and nothing written
  (`harness-sink: refused <path> <origin>` in the log).
- `logs.ljson` is capped per run at 50 000 lines and 64 MiB. The first batch
  over either writes ONE `sink/cap-reached` entry (level `warn`); every later
  entry is dropped but still answered 200, so the page stops resending.
- It never opens, closes, navigates or activates a page; the agent's own
  DevTools client is unaffected.

It is stopped after the browser closes. Its log is
`<run dir>/harness-sink/harness-sink.log`; `agent.json` gains `harnessSink`
(absent under `local`). A sink that does not print `harness-sink: ready` within
30 s, or whose deno would load from the agent work dir or a temp dir (see "Why
the harness scopes deno permissions"), ends the run `unfinished`, blocker
`harness-sink-failed`; one that exits while the agent drives (usually: the
browser died) cancels the job, blocker `harness-sink-exited` unless the agent
named its own.

The sidecar's dir is in the run dir, so **the run dir (the ux-test log root)
must not sit under `/tmp`, `/var/tmp`, `$TMPDIR` or `/var/folders`** (on macOS
the default temp dir is judged as all of `/var/folders`). A host whose log root
(`llm_logger_dir`) is there ends every sink run `harness-sink-failed` with
`harness-sink: error refusing to run deno: the sidecar's script dir in the run
dir <run dir>/harness-sink, inside the temp dir …`. The run dirs on rwc-dev-01
and rwc-01 are repo-side, not under a temp dir.

### Google sign-in pre-step (`UX_GOOGLE_PASSWORD_FILE`)

A profile with no live Google session makes "Sign in with Google" ask for an
email and a password, and the agent must never type a password (its brief says
so, and keeps saying so). When the host names a password file, ux-test signs
the profile in itself, deterministically, BEFORE the agent's job is enqueued:
the pre-step's DevTools port is an unauthenticated loopback listener, open
while Google's password page is, and no agent may be running then.

1. ux-test takes the profile's lock (`<UX_USER_DATA_DIR>/ux-test.lock`, a
   `flock` held until the agent's browser has closed), waiting up to
   `UX_AGENT_QUEUE_WAIT_SECS` while another run holds it. The lane's
   `max-running 1` cannot say the profile is free yet — no job exists — so the
   lock does. A profile that stays held ends the run `unfinished`, blocker
   `agent-queue-timeout`, with no job enqueued. It then opens the profile on a
   PRIVATE DevTools port — not the one the prompt names — at `about:blank`.
2. It runs `google-signin.deno.ts` (source: `tento-ux-runner/`, embedded in
   the binary and written to `<run dir>/google-signin/`) with
   `deno run --no-prompt --cached-only --config <runner>/deno.json`, network only
   to that port, reads/writes only in that dir, and an environment cut down to
   `PATH`, `HOME`, `DENO_DIR`, `XDG_CACHE_HOME`, `TMPDIR`, `LANG` and `LC_ALL`
   (never `DEBUG`, under which puppeteer-core logs every key it types). The
   password goes to the script's **stdin** (the file's bytes less one trailing
   newline) — never its argv or env, never a log, a trace, `agent.json` or the
   prompt. The script
   opens its own tab at Google's sign-in page, picks the account, types the
   email and the password as needed, and closes only its tab. It never
   screenshots while a password field holds a value. No user-agent override,
   no stealth, no `Emulation.*`: a refusal is a result.
3. That browser is closed, the job is enqueued, and once it runs the agent's
   browser opens the profile as usual.

Its one stdout status line decides the run:

| Status line | Exit | Run |
| --- | --- | --- |
| `google-signin: already-signed-in` | 0 | proceeds to the agent |
| `google-signin: signed-in` | 0 | proceeds to the agent |
| `google-signin: needs-human <reason>` | 3 | `unfinished`, blocker `google-signin-needs-human` (a 2-step or other challenge, captcha, "verify it's you", `provider-rejects-browser`, `wrong-password`, `wrong-account`, …); a screenshot is in `<run dir>/google-signin/` |
| `google-signin: timeout <state>` | 1 | `unfinished`, blocker `google-signin-timeout` |
| `google-signin: error <reason>` | 1 | `unfinished`, blocker `google-signin-error` (also: no runner on this host, deno missing, or deno's runner, cache or binary inside the agent work dir or a temp dir, see below) |
| no status line | any | `unfinished`, blocker `google-signin-no-status` |

A blocked pre-step ends the run before any job is enqueued (`agent.json`:
no `jobId`, `canceled` = `google-signin`): no agent ever ran, and the run tears
down and writes `verification.json` = `not_run` like every other unfinished
run. `agent.json` gains `googleSignin`,
the status line (absent when no pre-step is configured). The script's stderr is
`<run dir>/google-signin/google-signin.log`; the pre-step browser's is
`browser.log` beside it.

The password file: mode `0600` (ux-test refuses a group- or world-readable
one), outside every repo, and only its PATH is ever in the environment — the
account's password itself is never exported. A host that sets it must also set
`UX_USER_DATA_DIR` (ux-test refuses to start otherwise): the signed-in profile
must not be the work dir's `chrome-profile`, which the agent can read. For example, in the runner's env:
`UX_GOOGLE_ACCOUNT=operator-tester@lona.so UX_GOOGLE_PASSWORD_FILE=<path>`.

### Microsoft sign-in pre-step (`UX_MICROSOFT_PASSWORD_FILE`)

The same pre-step for a Microsoft account, so an app's "Connect Outlook" or
"Reconnect" reaches Microsoft's consent with a live session and the agent never
sees a password page. Everything above holds — the profile lock, the private
DevTools port, the cut-down environment, the password on stdin only, no
screenshot while a password field holds a value — with these differences:

- The script is `microsoft-signin.deno.ts`, written to
  `<run dir>/microsoft-signin/` (log `microsoft-signin.log`). With both
  providers configured, both run on the one private browser, Google first,
  under `<run dir>/signin/{google,microsoft}-signin/`; the first that does not
  sign in ends the run.
- It opens the tested app's root `/signin?flag:outlook-provider=true` and
  asks its "Continue with Microsoft" handler to build the OAuth URL. The
  private tab visits that exact URL. Newer apps start at their canonical
  `/api/user/signin/outlook/redirect?start=true` endpoint so the signed browser
  session carries OAuth state before the server redirects to Microsoft. Older
  direct common-tenant `prompt=select_account` URLs remain accepted only when
  their redirect URI matches the tested app's canonical callback.
  A matching account tile there means `already-signed-in`; merely seeing the
  account on `login.live.com` or `account.microsoft.com` never does.
- An identifier form ("Email, phone, or Skype") is driven: enter the configured
  account, then type the password supplied on stdin by ux-test from
  `UX_MICROSOFT_PASSWORD_FILE`. Answer "Stay signed in?" Yes and consent Accept
  once. A successful server-rendered Outlook callback at the OAuth redirect
  URI finishes signed-in after credentials were entered. A failed callback
  stops with `challenge oauth-failed`; an unknown page never triggers a
  fallback visit to a consumer account home.
- ANY other screen — a code or Authenticator prompt, "Help us protect your
  account", security info, a CAPTCHA or puzzle, a passkey or another sign-in
  method offered instead, a lock, a page it does not know — ends the step.
  It records visible body text (`microsoft-signin-<reason>.txt`) and a screenshot
  after emptying all password inputs. It never answers a challenge or switches
  method. The agent lane's status mapping and password isolation are unchanged.

| Status line | Exit | Run |
| --- | --- | --- |
| `microsoft-signin: already-signed-in` | 0 | proceeds |
| `microsoft-signin: signed-in` | 0 | proceeds |
| `microsoft-signin: challenge <reason>` | 3 | `unfinished`, blocker `microsoft-challenge` — an operator step; the screenshot is `microsoft-signin-<reason>.png` |
| `microsoft-signin: timeout <state>` | 1 | `unfinished`, blocker `microsoft-signin-timeout` |
| `microsoft-signin: error <reason>` | 1 | `unfinished`, blocker `microsoft-signin-error` |
| no status line | any | `unfinished`, blocker `microsoft-signin-no-status` |

A blocked Microsoft pre-step records `canceled` = `microsoft-signin`;
`agent.json` gains `microsoftSignin`, its status line.

The pre-step is not a read-only look at Microsoft's session. It ends at the tested
app's real Outlook sign-in callback (in lona, `/api/user/signin/outlook/redirect`),
and that callback does what a person's sign-in does: it exchanges the code,
registers the user when this is the account's first login, signs the browser in,
and, for an account it creates, records the account-registered funnel event and an
ads conversion. That happens on whichever server the run targets, production
included. The pre-step runs after the spec's setup, so a Microsoft spec whose
setup deletes its account gets that account re-created, and counted as a new
signup, before the agent starts. Such a spec cannot rely on the account being
absent, and its signups are synthetic.

### Which pre-steps a spec gets (`signin_providers:`)

A spec can declare the sign-in pre-steps its agent-driven steps need, at the
top level of `spec.yaml`:

```yaml
signin_providers: [google, microsoft]   # both, Google first
signin_providers: [microsoft]           # Microsoft only
signin_providers: []                    # no pre-step at all
```

Present ⇒ exactly the listed pre-steps run (each still only when the host
names its password file), whatever the steps' text says. A name other than
`google` or `microsoft` fails the spec's load rather than skipping a
pre-step. `signinProviders` (the serializer's spelling) loads the same way.

Absent ⇒ the inference every existing spec relies on, unchanged (back-compat):
Google's pre-step runs for every agent-driven spec, and Microsoft's only when
a manual step's id, instruction or `manual_reason` contains "microsoft" or
"outlook" (any case). That match misses wording such as "Hotmail",
"Office 365", "Entra" or "work account" (review K-8), so a spec that needs
Microsoft under other words should declare the field. The run log names the
reason for each skipped pre-step.

### Why the harness scopes deno permissions

Three deno processes are handed a password: the Google and Microsoft sign-in
pre-steps (on stdin, before the agent starts) and the `fill_secret` typist
(while the agent drives). Their flags keep deno away from the agent's work dir
(`<run dir>/agent`, the only directory the agent and its spec write). The
typist gets no file access at all and network only to the agent's DevTools
port. A pre-step reads and writes only its own dir beside the run
(`<run dir>/google-signin/`, or under `<run dir>/signin/` when both run). All
three get only the env allowlist above.

The flags cannot cover what deno loads: the runner's `deno.json` and
`node_modules`, `DENO_DIR` (npm and remote module caches, emitted JS, the V8
code cache) and the deno binary. **npm loads are not lockfile-pinned.** Deno
checks a package's integrity only when it extracts the tarball, never when it
loads an extracted copy, so an edited `node_modules` or npm cache loads even
under `--frozen --lock` (review K-11). The guarantee therefore rests on the
**allow-workspace assumption**: the agent can write only its work dir. On an
ACP lane, tsh's `allow-workspace` rule (above) confines the agent's file tools,
`mkdir` and `deno run --allow-write` to the lane cwd, which is the work dir. On
a Codex lane, the `workspace-write` sandbox lets the agent write its cwd,
`/tmp`, `$TMPDIR` and any `writable_roots` in the Codex config.

The harness makes the layout half of that assumption fail closed (operator
decision X-D2). Before each pre-step and each typist spawn, it resolves these
paths: the runner dir, its `deno.json` and `node_modules`, the child's
`DENO_DIR` (deno's default when unset: `$XDG_CACHE_HOME/deno` or
`~/.cache/deno` on Linux, `~/Library/Caches/deno` on macOS), and the deno
binary (the first executable `deno` on the child's `PATH`). Symlinks are
followed both ways. A link outside that points in fails, and so does a link
inside that points out, because the agent can re-point it. Links are resolved
hop by hop (review O-3, operator decision OQ-3): every link a path passes
through, mid-way included, is judged by its own location as well as by where
it leads, so `/out/x/deno` with `/out/x` → `<work dir>/l` → `/out/real` fails.
A path that does not exist yet is judged by its deepest existing ancestor, and
one that cannot be resolved (a dangling link, a loop) is refused. On macOS a
link inside a directory the harness cannot list is refused as well, even when
spelled exactly, because its on-disk spelling cannot be told there (review
L14b, decision AH-D1): put the runner, DENO_DIR and TMPDIR under listable
directories.

The check also runs the other way round (review L10 Z3): a root the agent may
write that sits inside one of these paths fails too, since the agent could
then write into it, e.g. a work dir or `TMPDIR` inside `DENO_DIR` or the
runner dir (`refusing to run deno: the agent work dir … sits inside DENO_DIR
(deno's module cache) …`). Keep the run dirs beside the runner and the cache,
as both hosts do.

The temp dirs a Codex sandbox also opens count like the work dir (operator
decision OQ-1): the child's `TMPDIR`, `/tmp`, `/var/tmp`, `/private/tmp`,
`/private/var/folders` and `/var/folders`. The child's `TMPDIR` is read from
the env the child gets. When it is unset (or empty), the platform default it
falls back to is judged instead: Rust's and so deno's `temp_dir` gives `/tmp`
on Linux, and on macOS a per-user dir under `/var/folders`, which the check
judges as all of `/var/folders` (broader, and a fixed root anyway). These
roots are resolved the same way, so a root that is a link (macOS `/tmp` →
`/private/tmp`) or does not exist yet is judged where it leads. So a runner,
cache or deno binary kept under a temp dir is refused, not trusted.

The harness's own `TMPDIR` is judged too, apart from the child's (review L10
Z1). The agent lane is run by the host queue, not by the harness, so the
harness cannot read the lane's env; a lane started from the same session
shares the harness's `TMPDIR`, and a fenced tsh lane makes its private temp
dir under it (`<TMPDIR>/tsh-lanes-<uid>/…`). So a child handed a private
`TMPDIR` does not take the lane's out of the check. When the harness has no
`TMPDIR`, the lane's default (`/tmp`, `/var/folders`) is a fixed root anyway.

When any of these paths lands inside the work dir or a temp dir, the step fails
with an error naming the path, what it is and the root it is under (`refusing
to run deno: DENO_DIR (deno's module cache) /tmp/x/deno, inside the temp dir
/tmp`). Nothing is spawned or written, and a pre-step has not yet read its
password file (the typist's secret, already read by the harness, goes no
further): the pre-step reports `<provider>-signin: error refusing to run deno:
…`, and the typist answers `refused: fill-error refusing to run deno: …`.

The harness sink gets the same check before it starts (OQ-1). It is handed no
password, but it runs from the same deno and `DENO_DIR` while the agent drives
and writes `session.json`, `logs.ljson` and `complete.json`, which decide the
run's result. It runs `--no-config`, so in place of a runner the check judges
its own dir (`<run dir>/harness-sink/`), over the full environment the sidecar
is spawned with. A refusal ends the run `unfinished`, blocker
`harness-sink-failed`, with `harness-sink: error refusing to run deno: …`; a
refused sidecar dir is named `the sidecar's script dir in the run dir`, since
it means the run dir is misplaced (see "Harness-post sink" above). A sane
layout behaves exactly as before.

What the check does not guarantee is the contents of those directories. It
cannot catch a lane whose sandbox lets the agent write outside its work dir and
the temp dirs. Examples: a shell, `danger-full-access`, Codex `writable_roots`
or a lane cwd that covers the runner, `DENO_DIR` or the binary, and a lane
whose `TMPDIR` is neither the harness's nor under a fixed temp root (say, a
queue worker started with its own). An agent like that can already read the
password files. Do not run ux-test agents on such a
lane. If one is needed, give the harness a private runner install (its own
`node_modules`, `DENO_DIR` and deno, outside every root the agent can write;
X-D2 option b).

## Performance runs: real GPU and trusted scroll bursts

Two spec options make a headless run usable as performance evidence.

**`gpu: true`** (top level of `spec.yaml`, or `UX_GPU=hardware` in the run's
environment) launches Chrome with ANGLE on the machine's GPU (Metal on macOS)
and the GPU blocklist ignored. Every headless run, with or without it, reads
`UNMASKED_RENDERER_WEBGL` from the booted page into `<run dir>/renderer.json`
(`requested`, `vendor`, `renderer`, `context`, `software`) and appends the
renderer to the completion feedback. When the GPU was requested and the page
reports a software renderer (SwiftShader, llvmpipe, or no WebGL context), the
run fails before its first step, so a GPU round cannot silently be a software
one. Without the request nothing about the launch changes.

**`scroll_burst`** is a step action that sends `steps` scroll inputs of
`dx`/`dy` px over `target`'s centre (or `x`/`y`), one per `interval_ms`
(default one 60 Hz frame), as real CDP input (`isTrusted` true):

```yaml
- { action: scroll_burst, target: "std-sheet", dx: 120, steps: 30 }            # mouseWheel per frame
- { action: scroll_burst, x: 640, y: 400, dy: 40, steps: 30, mode: gesture }  # one synthesizeScrollGesture
```

`mode: wheel` (default) paces one `Input.dispatchMouseEvent` per step against
the burst's own clock and launches with smooth scrolling off; `mode: gesture`
issues one `Input.synthesizeScrollGesture` (mouse source, no fling) at the
same overall speed. `await: false` returns at once (the run still waits for
the burst before completing); `trace: name` records a Chrome trace to
`<run dir>/name.trace.json`. A passive page listener timestamps every `wheel`
event the document received, and `<run dir>/scroll-burst-<step>.json` records
the received count, trusted count and inter-event spacing (mean, p50, p95,
max), plus the runner's dispatch spacing in wheel mode.

Wheel mode's `pace` decides when the next step is sent. `ack` (default) waits
for each `Input.dispatchMouseEvent` to return, and Chrome returns it only once
the renderer has handled the event, so on a busy page the burst runs at the
page's pace (about 30 Hz on the dense calendar) instead of the display's.
`pace: clock` sends every step at its scheduled time without waiting, awaits
all the calls at the end, and fails the step if any call failed. The record
then holds `dispatched` (when steps were sent), `acked` (when the calls
returned) and `received` (when the page saw them): a received spacing wider
than the dispatched one is the page failing to keep up.

A traced burst records the categories in `trace_categories` (a list), or by
default `devtools.timeline`, `disabled-by-default-devtools.timeline`,
`disabled-by-default-devtools.timeline.frame`, `blink.user_timing`,
`latencyInfo`, `cc`, `gpu`, `v8.execute`, which name the style, layout,
paint, layerize and commit work of each frame. The trace starts before the
pointer move and a 300 ms quiet settle, so the frame that starting the trace
costs falls before the first input; the record carries `traceCategories`,
`traceStartMs` (how long the start call took) and `traceSettleMs`.

```yaml
- { action: scroll_burst, target: std-sheet, dx: 120, steps: 30, pace: clock }
- { action: scroll_burst, target: std-sheet, dx: -120, steps: 30, mode: gesture, trace: fling }
```

**`click`** takes an optional `button: left | right | middle` (default left).
The runner presses the browser's real mouse at the element's centre (the
selector may pierce shadow roots with `>>>`), so `button: right` delivers a
trusted `contextmenu` event with `button === 2`, as a user's right-click does:

```yaml
- { action: click, selector: "std-sheet >>> .grid", button: right }
```

## `ux-test run --json` / `--json-out <path>`

`run` can emit what it did as a typed document, so a pipeline does not have to
scrape the human tally.

- `--json` prints the document on stdout and moves the human output to stderr.
  The Deno runner (`--auto`) still inherits stdout, so a parser should prefer:
- `--json-out <path>` writes the same document to `path` (atomically, on every
  exit path after argument parsing) while stdout stays the unchanged human
  output. If the file cannot be written, the command exits non-zero.

Without either flag the human output is byte-for-byte what it was.

The document (`ux-test.run-report/v1`, Rust type `tento_ux_test::RunReport`).
Keys are camelCase. Absent optionals are omitted, not `null`:

```json
{
  "type": "ux-test.run-report/v1",
  "exitCode": 0,
  "startedAt": "2026-09-24T18:00:00Z",
  "endedAt": "2026-09-24T18:01:30Z",
  "runner": { "host": "rwc-04", "version": "0.1.0" },
  "artifact": { "product": "lona", "version": "1.0.87", "gitHash": "ab12cd34…", "stem": "lona-1.0.87-macos-arm64" },
  "profiles": [{
    "env": "rc",
    "target": "https://rc--calendar.lona.so",
    "selection": { "kind": "group", "name": "events" },
    "label": "group events · env rc",
    "outcome": "passed",
    "counts": { "passed": 1, "partial": 0, "failed": 0, "skipped": 1 },
    "specs": [
      {
        "id": "event-flow-create", "group": "events", "outcome": "passed",
        "run": "2026-09-24_event-flow-create_a5c3cf",
        "sessionDir": "/corpus/events/event-flow-create/runs/2026-09-24_event-flow-create_a5c3cf",
        "target": "https://rc--calendar.lona.so",
        "user": "operator-tester@lona.so", "userSource": "spec",
        "durationMs": 41250, "result": "success (auto, verify=true)",
        "artifact": { "product": "lona", "version": "1.0.87", "gitHash": "ab12cd34…" }
      },
      {
        "id": "event-flow-oauth", "group": "events", "outcome": "skipped",
        "skipReason": "first_step_manual", "manualReason": "third-party consent screen"
      }
    ]
  }]
}
```

| Field | Meaning |
| --- | --- |
| `exitCode` | `0` if the command returned success, `1` if it returned an error |
| `error` | why the command failed outside any profile (unknown `--env`, bad artifact stamp) |
| `profiles[]` | one per `--env` profile, in the order given |
| `profiles[].selection.kind` | `group` · `test` · `all` · `file` · `ephemeral` |
| `profiles[].outcome` | `passed` · `failed` (a spec failed or the profile errored, whatever the exit code) · `nothing_to_run` |
| `profiles[].counts` | the same four numbers as the `=== batch run: … ===` line, computed by the same code |
| `profiles[].nothingToRun` | `{skipped, reason}` when the selection drove nothing; `reason` is the printed `no tests to run …` line |
| `profiles[].target` | the origin every driven spec agreed on; omitted when they differ (multi-origin products) |
| `specs[].outcome` | `passed` · `partial` · `failed` · `skipped` |
| `specs[].skipReason` | `not_auto_runnable` · `first_step_manual` · `unparseable` |
| `specs[].run` | the session id (`<date>_<test>_<hex>`); present even when the run errored after the session was created |
| `specs[].user` / `userSource` | the account the headless browser drove, and whether it came from `flag` (`--user`), `spec` (`params.user_email`, after setup) or `host_default`. Omitted on manual runs |
| `specs[].note` / `blocker` | the text the ledger entry records: the failure feedback, and the blocker slug |

## `ux-test spec.accounts`

For each spec in a selection (`--root`, `--group`, `--test`, `--scratch`), the
account its `params.user_email` names, read with the runner's own YAML parser:

```json
{ "type": "ux-test.spec-accounts/v1", "root": "/…/.ux-tests", "specs": [
  { "id": "a", "group": "events", "manual": false, "manualReason": null, "skipReason": null,
    "user": "operator-tester@lona.so", "account": { "kind": "account", "email": "operator-tester@lona.so" } },
  { "id": "b", "group": null, "manual": true, "manualReason": null, "skipReason": "not_auto_runnable",
    "user": null, "account": { "kind": "none" } },
  { "id": "c", "group": null, "manual": true, "manualReason": null, "skipReason": "unparseable",
    "user": "unknown", "account": { "kind": "unknown", "reason": "Failed to parse test spec YAML: …" } }
]}
```

`manual` is `run --all --auto`'s own skip decision. `unknown` means the spec does
not parse (so the runner cannot run it either), or its `user_email` is empty or
templated (`{{…}}`).

## Artifact stamp

`run` and `log` accept `--artifact-product`, `--artifact-version`,
`--artifact-sha` (all three required together), plus the optional
`--artifact-stem` and `--artifact-fingerprint`. With no flags, the
`TENTO_UX_ARTIFACT` env var is read as a JSON object
`{product, version, gitHash|sha|git_hash, stem?, fingerprint?}`. A malformed
stamp is an error, not a silent "unstamped".

The stamp is written to every ledger entry the run appends
(`ledger.ljson` → `"artifact": {…}`) and to `RunReport.artifact` /
`specs[].artifact`. Entries written before the field existed have no
`artifact` key, and readers treat that as "not said". `ux-test finalize`
stamps nothing because it adopts a session it did not start.
