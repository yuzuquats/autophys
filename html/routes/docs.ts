/**
 * The single-page documentation the cookbook draws below the landing deck and above the
 * footer. Sources: README.md, sdks/python/README.md and autophys.project.docs/content
 * (architecture.md, muse-plugin.md). Keep every claim checkable there; numbers that need a
 * real run stay out of this page (the deck's TBDs cover them).
 */
import type { Cookbook } from "@tento-cookbook/lib.ts";

export function docs(_app: Cookbook.App): Cookbook.Docs.Page {
  return {
    eyebrow: "Documentation",
    title: "How autophys works",
    description:
      "autophys fits a physical model to your measurements, then tells you which parameters those measurements actually pin down, and which experiment to run next.",
    sections: [
      {
        id: "overview",
        title: "Overview",
        blocks: [
          {
            kind: "p",
            text:
              "A parameter counts as identified only if the data determines it to better than ±10%. That verdict comes from a sensitivity analysis (an SVD of the log-Jacobian), not from how good the fit looks.",
          },
          {
            kind: "p",
            text:
              "When parameters are tied together, autophys ranks the candidate experiments by Fisher information and proposes the one that would separate them. An agent (Muse Spark, or a scripted policy) can drive that loop, and a person approves each experiment in this workbench before it runs.",
          },
        ],
      },
      {
        id: "quick-start",
        title: "Quick start: fit a battery cell",
        blocks: [
          { kind: "p", text: "You need Python 3.10 or newer. There are no accounts or keys." },
          {
            kind: "code",
            label: "Fit the bundled demo cell",
            code: [
              "git clone https://github.com/yuzuquats/autophys.git",
              "cd autophys/examples/battery_fit",
              "./run.sh                              # fits the bundled demo cell, writes fit.png",
              "./run.sh my_cell.csv --sigma 0.002 --ocv my_ocv.csv --out my_cell.png",
            ].join("\n"),
          },
          {
            kind: "p",
            text:
              "`examples/battery_fit/README.md` covers inputs, sample data, expected output and how to read the result, including the R1 ↔ C1 trade-off that a single pulse leaves unresolved.",
          },
        ],
      },
      {
        id: "loop",
        title: "The closed loop",
        blocks: [
          {
            kind: "list",
            ordered: true,
            items: [
              "Fit the model to the measurements you have.",
              "Check identifiability: each parameter is either identified or tied to others.",
              "Rank the catalogue experiments by how well they would separate the tied parameters.",
              "The agent proposes one, with its rationale and expected information.",
              "You approve, edit or reject it here in the workbench.",
              "The new data is attached to the proposal, and the loop fits again.",
            ],
          },
          {
            kind: "p",
            text:
              "A proposal moves from `proposed` to `approved`, `edited` or `rejected` (or `withdrawn` by the SDK), then to `data_attached`. The final report's identified list is always recomputed and checked in code; the agent cannot assert it.",
          },
        ],
      },
      {
        id: "python-sdk",
        title: "Python SDK",
        blocks: [
          {
            kind: "p",
            text:
              "Wrap your simulator with `@ap.simulator`, describe the project and its budgets, and run an investigation. It stops at `awaiting_data` at the first proposal; any later process can resume it from the records.",
          },
          {
            kind: "code",
            label: "Python SDK example",
            code: [
              "import autophys as ap",
              "",
              '@ap.simulator(params={"C": ("J/K", 10, 1e5), "R": ("K/W", 0.01, 100)},',
              '              experiments={"step": {"kind": "step", "power": 10, "duration": 120, "rate": 1}},',
              '              outputs=("T",))',
              "def block(params, experiment, options=ap.FIT_OPTIONS):",
              '    ...  # return {"t": t, "T": temperature}',
              "",
              'project = ap.Project("heated-block", block, budgets=ap.Budgets(max_experiments=2))',
              'wb = ap.connect("~/autophys").project(project)',
              "inv = wb.investigate(measurements, ap.ProposalRunner(), policy=ap.ScriptedPolicy())",
              'outcome = inv.run()            # ends "awaiting_data" at the first proposal',
              "",
              "# later, in any process:",
              'inv = ap.connect("~/autophys").project(project).investigation(outcome.investigation)',
              "inv.wait_for_approval()        # your approve/edit in the workbench lands in the workbook",
              "inv.attach_data(outcome.proposal_id, observation)",
              "inv.run()",
            ].join("\n"),
          },
          {
            kind: "table",
            columns: ["Call", "What it does"],
            rows: [
              ["`ap.connect(target)`", "A directory, a `.ap-workbook` file, an `http(s)://` daemon URL, or nothing (`$AUTOPHYS_HOME`, default `~/autophys`)."],
              ["`client.project(project)`", "The project's workbook, created if new."],
              ["`wb.investigate(…)`", "A new recorded investigation; `.run()` runs the loop."],
              ["`wb.investigation(id)`", "Resume an investigation from its records."],
              ["`inv.approve` / `reject` / `attach_data`", "The proposal verbs; `wait_for_approval()` blocks until a reviewer decides."],
            ],
          },
        ],
      },
      {
        id: "workbooks",
        title: "Workbooks",
        blocks: [
          {
            kind: "p",
            text:
              "Each project lives in one workbook, `<project>.ap-workbook`, a SQLite file. Records are appended to a hash-chained log under the daemon's validation and proposal rules, so the SDK, a second process and this workbench can all write the same file. The Rust and Python SDKs implement the same format.",
          },
        ],
      },
      {
        id: "muse",
        title: "Muse Code plugin",
        blocks: [
          {
            kind: "p",
            text:
              "The plugin runs a local MCP server next to your simulator, so Muse can drive the calibration while the numerical work stays in the SDK.",
          },
          {
            kind: "code",
            label: "Install the Muse plugin",
            code: [
              "pip install -e 'sdks/python[mcp]'",
              "muse plugins install plugins/muse-autophys",
              "python -m autophys.cli mcp --project mypkg.module:project --workbook ~/autophys",
            ].join("\n"),
          },
          {
            kind: "p",
            text:
              "Tools: `describe_project`, `import_measurements`, `fit`, `identifiability`, `rank_experiments`, `propose_experiment`, `status`, `attach_data` and `report`. There is no approve or reject tool: experiments are approved here, in the browser.",
          },
        ],
      },
      {
        id: "workbench",
        title: "The workbench",
        blocks: [
          {
            kind: "p",
            text:
              "Open the workbench from the top of this page. The sidebar lists projects and their investigations; the main pane draws measured data, parameter estimates and sensitivity; the details panel shows the selected record. The workbench reads the daemon's recorded investigation and updates live as records arrive.",
          },
          {
            kind: "p",
            text: "It does not draw the fitted curve yet; use the battery example for curves.",
          },
        ],
      },
      {
        id: "repo",
        title: "Repository map",
        blocks: [
          {
            kind: "table",
            columns: ["Path", "What it is"],
            rows: [
              ["`examples/battery_fit`", "Fit a measured battery trace, check identifiability, plot the curve."],
              ["`sdks/python`", "Python SDK: simulator, fit, identifiability, experiment ranking, agent loop, workbook."],
              ["`sdks/rust`", "Rust SDK."],
              ["`plugins/muse-autophys`", "Muse Code plugin (local MCP server)."],
              ["`src/`, `html/`", "Rust daemon and this browser workbench."],
              ["`autophys.project.docs`", "Design notes and decisions."],
            ],
          },
        ],
      },
    ],
  };
}
