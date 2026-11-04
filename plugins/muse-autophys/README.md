# autophys for Muse Code

autophys meets engineers inside the agent they already use.

Install the SDK with its optional protocol dependency, then install this native
Muse Code 1.4.14 bundle:

```sh
python -m pip install -e 'sdks/python[mcp]'
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

The Python CLI and Rust daemon both use the name autophys. Prefer an explicit
venv Python in a generated bundle to avoid PATH ambiguity:

```sh
python3 plugins/muse-autophys/build.py --output /tmp/my-autophys-plugin \
  --python /absolute/path/to/venv/bin/python \
  --project battery_ecm --workbook /absolute/path/to/autophys-books \
  --root /absolute/path/to/lab
muse plugins install /tmp/my-autophys-plugin
```

For your own simulator use `--project mypkg.module:project` (a Project or an
`@ap.simulator`). The local process imports trusted lab code. No simulator is
loaded in the daemon.

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

For a simulator on another machine, the builder accepts an optional SSH stdio
bridge. Configure your own SSH host and remote paths; the SDK interpreter and
simulator must already be installed there:

```sh
python3 plugins/muse-autophys/build.py --output /tmp/autophys-ssh-plugin \
  --ssh-host my-lab --python /absolute/remote/venv/bin/python \
  --source-root /absolute/remote/autophys/sdks/python/src \
  --root /absolute/remote/lab --workbook /absolute/remote/books --project battery_ecm
```

Build the bundle where Muse runs and install it there. The generated shell wrapper uses SSH's existing authentication and
contains no credentials. The full guide has a reproducible synthetic CSV setup.
