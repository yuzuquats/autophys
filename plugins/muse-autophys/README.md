# autophys for Muse Code

autophys meets engineers inside the agent they already use.

Build the `autophys` binary, then install this native Muse Code 1.4.14
bundle:

```sh
cargo build --release --bin autophys
muse plugins install ./plugins/muse-autophys
```

Muse may request trust for the MCP capability; use the IDs returned by install
or inspect with `muse plugins approve autophys`. This trusts tool definitions,
not experiment proposals. Experiment approval stays in the autophys browser.

The source manifest launches `autophys mcp` from PATH, with
`.autophys-mcp.json` in the lab working directory:

```json
{"project":"battery_ecm","workbook":"/absolute/path/to/autophys-books","root":"/absolute/path/to/lab"}
```

A generated bundle can name the binary explicitly:

```sh
python3 plugins/muse-autophys/build.py --output /tmp/my-autophys-plugin \
  --autophys "$PWD/target/release/autophys" \
  --project battery_ecm --workbook /absolute/path/to/autophys-books \
  --root /absolute/path/to/lab
muse plugins install /tmp/my-autophys-plugin
```

The server is the Rust binary and serves the built-in `battery_ecm` project;
it cannot import a Python simulator (`--project mypkg.module:project` is
refused). No simulator is loaded in the daemon.

The builder copies `sdks/python/src/autophys/playbooks/default/SKILL.md`
byte for byte and records its sha256 in playbook.json. Rebuild after a canonical
skill change. No separate strategy is maintained here. The calibrate command
maps the strategy to the nine MCP tools.

CSV battery defaults are time (seconds), current (A, positive discharging), and
voltage (V); specify sigma as `{"v":0.002}` for a 2 mV noise standard deviation.
The built-in path supports the declared discharge_1A, pulse_2A and pulse_train
waveforms and grids. A mismatched waveform or time grid fails, so real lab
experiments must be declared accurately rather than guessed.

See `autophys.project.docs/content/muse-plugin.md` for the demo, tool table
and offline verification receipt.

For measurements on another machine, the builder accepts an optional SSH stdio
bridge. Configure your own SSH host and remote paths; the `autophys` binary
must already be installed there (`--autophys` names it; default `autophys` on
the remote PATH):

```sh
python3 plugins/muse-autophys/build.py --output /tmp/autophys-ssh-plugin \
  --ssh-host my-lab --autophys /absolute/remote/bin/autophys \
  --root /absolute/remote/lab --workbook /absolute/remote/books --project battery_ecm
```

Build the bundle where Muse runs and install it there. The generated shell wrapper uses SSH's existing authentication and
contains no credentials. The full guide has a reproducible synthetic CSV setup.

The manifest names `./mcp-stdio.sh` as its executable. Muse resolves that
package-relative executable to the installed package, including after relocation.
The wrapper resolves its config and canonical playbook beside itself; it keeps
the workspace/lab working directory unchanged. Relative workbook/root paths
therefore still refer to the lab. Rebuild and reinstall older generated bundles
whose manifest used `sh mcp-stdio.sh` or relative resource arguments.

Generated local and SSH launchers pass `--expected-playbook-sha256`, binding
MCP to the exact strategy bytes copied into the package. The remote binary must
support that option. Before importing a lab project or opening a workbook it
refuses an ambient/default playbook with a different digest. A custom package
does not silently upload or replace remote strategy files: install those exact
bytes yourself and select them with `playbook` in the remote lab's
`.autophys-mcp.json`. Rebuild/reinstall after an intentional strategy change;
resuming an investigation still requires its recorded pinned strategy.
