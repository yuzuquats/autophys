# autophys meets engineers inside the agent they already use

Status: integration design, rev 1, 2026-11-04. The offline implementation is
being added here. Live Meta calls await an operator-approved token budget.

An engineer opens Muse Code in a lab repo and asks it to calibrate a cell
from `pulses.csv`. A local MCP server imports measurements and runs the SDK's
fit, identifiability rule and experiment design. Proposals go into the same
workbook as `ap.connect(...)`; a human reviews them in the browser.

Muse Code 1.4.14's bundled native plugin contract explicitly accepts
`capabilities.mcpServers` with `transport: "stdio"` and structured command
argv in `.muse-plugin/plugin.json`. Its `muse mcp --help` describes HTTP
OAuth only; it is not the transport capability list.

## The path through the system

```
lab repo / pulses.csv → Muse Code + canonical playbook
                              │ stdio MCP
                              ▼
                       local Python SDK
                  fit → SVD → rank → proposal
                              │ ap.connect(target)
                              ▼
                      project.ap-workbook ← browser approval
                              │
                      attach data → checked report
```

## Choices the implementation carries

Agent-chosen, pending operator review. These choices add no workbook format.

```review-table
| Id | Choice and reason | Strongest alternative | Reverse |
| -- | ----------------- | --------------------- | ------- |
| MP-1 | Stdio, supported by Muse's native manifest; no listening socket | Loopback HTTP needs a separate lifecycle | replace transport adapter and manifest |
| MP-2 | Official MCP SDK in optional autophys[mcp]; core keeps numpy/scipy only | Handwritten JSON-RPC duplicates protocol maintenance | replace adapter |
| MP-3 | Nine compact tools call Investigation; no approve/reject or agent-supplied identified list | Generic Python execution widens the surface | change registrations |
| MP-4 | Builder copies canonical M-2 SKILL.md byte for byte and records its hash | A second playbook would drift | rebuild from canonical source |
| MP-5 | CSV current must match a declared battery experiment; wrong waveforms fail explicitly | Guessing an input waveform risks fitting the wrong physics | add measured-waveform support with SDK owner |
```

The Python owner supplies the canonical playbook and battery case suite.
This work owns the MCP package, bundle and integration tests. Rust, the daemon
and browser UI keep their existing owners. Final verification and exact demo
commands will be recorded here after the offline checks.
