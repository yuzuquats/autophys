/**
 * The landing's documentation: one markdown page, drawn by tento-ui's std-documentation,
 * placed in the document flow after the viewport-height deck and before the cookbook footer,
 * so scrolling past the pitch reaches the manual. Sources: README.md, sdks/python/README.md
 * and autophys.project.docs/content (architecture.md, muse-plugin.md). Keep every claim
 * checkable there; numbers that need a real run stay out of this page (the deck's TBDs cover
 * them).
 *
 * std-documentation renders through tento's ProseMirror bundle, which tento-ui loads from
 * InstanceUrl.staticUrl("/js/prosemirror.min.js"). autophys serves no static subdomain, so the
 * static base is this origin and the bundle ships beside this file as js/prosemirror.min.js
 * (the committed tento-plugins-js build other tento apps serve, sha256 b4c9b9e4c64d…).
 *
 * Code blocks are coloured by tento-ui's own tokenizers (shell, Python), registered for their
 * fence names and drawn with Code's static rendering: the committed CodeMirror bundle predates
 * `streamLanguage`, so the editor path would draw a registered language plain. Static output
 * is read-only text with tok-* spans, which is all a documentation page needs.
 */
import "@tento-ui/components/documentation/documentation";
import { Documentation } from "@tento-ui/components/documentation/documentation";
import { Code } from "@tento-ui/components/code/code";
import { shellTokenizer } from "@tento-ui/components/code/languages/shell";
import { pythonTokenizer } from "@tento-ui/components/code/languages/python";
import { LispExampleView } from "@tento-ui/components/lisp-example/lisp-example-view";
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import { InstanceUrl } from "@tento-core/instance-url";
import type { Cookbook } from "@tento-cookbook/lib.ts";

export const DOCS_MARKDOWN = `# How autophys works

autophys fits a physical model to your measurements, then tells you which parameters those measurements actually pin down, and which experiment to run next.

## Overview

A parameter counts as **identified** only if the data determines it to better than ±10%. That verdict comes from a sensitivity analysis (an SVD of the log-Jacobian), not from how good the fit looks.

When parameters are tied together, autophys ranks the candidate experiments by Fisher information and proposes the one that would separate them. An agent (Muse Spark, or a scripted policy) can drive that loop, and a person approves each experiment in this workbench before it runs.

## Quick start: fit a battery cell

You need Python 3.10 or newer. There are no accounts or keys.

\`\`\`sh
git clone https://github.com/yuzuquats/autophys.git
cd autophys/examples/battery_fit
./run.sh                              # fits the bundled demo cell, writes fit.png
./run.sh my_cell.csv --sigma 0.002 --ocv my_ocv.csv --out my_cell.png
\`\`\`

\`examples/battery_fit/README.md\` covers inputs, sample data, expected output and how to read the result, including the R1 ↔ C1 trade-off that a single pulse leaves unresolved.

## The closed loop

1. Fit the model to the measurements you have.
2. Check identifiability: each parameter is either identified or tied to others.
3. Rank the catalogue experiments by how well they would separate the tied parameters.
4. The agent proposes one, with its rationale and expected information.
5. You approve, edit or reject it here in the workbench.
6. The new data is attached to the proposal, and the loop fits again.

A proposal moves from \`proposed\` to \`approved\`, \`edited\` or \`rejected\` (or \`withdrawn\` by the SDK), then to \`data_attached\`. The final report's identified list is always recomputed and checked in code; the agent cannot assert it.

## Python SDK

Wrap your simulator with \`@ap.simulator\`, describe the project and its budgets, and run an investigation. It stops at \`awaiting_data\` at the first proposal; any later process can resume it from the records.

\`\`\`python
import autophys as ap

@ap.simulator(params={"C": ("J/K", 10, 1e5), "R": ("K/W", 0.01, 100)},
              experiments={"step": {"kind": "step", "power": 10, "duration": 120, "rate": 1}},
              outputs=("T",))
def block(params, experiment, options=ap.FIT_OPTIONS):
    ...  # return {"t": t, "T": temperature}

project = ap.Project("heated-block", block, budgets=ap.Budgets(max_experiments=2))
wb = ap.connect("~/autophys").project(project)
inv = wb.investigate(measurements, ap.ProposalRunner(), policy=ap.ScriptedPolicy())
outcome = inv.run()            # ends "awaiting_data" at the first proposal

# later, in any process:
inv = ap.connect("~/autophys").project(project).investigation(outcome.investigation)
inv.wait_for_approval()        # your approve/edit in the workbench lands in the workbook
inv.attach_data(outcome.proposal_id, observation)
inv.run()
\`\`\`

| Call | What it does |
| --- | --- |
| \`ap.connect(target)\` | A directory, a \`.ap-workbook\` file, an \`http(s)://\` daemon URL, or nothing (\`$AUTOPHYS_HOME\`, default \`~/autophys\`). |
| \`client.project(project)\` | The project's workbook, created if new. |
| \`wb.investigate(…)\` | A new recorded investigation; \`.run()\` runs the loop. |
| \`wb.investigation(id)\` | Resume an investigation from its records. |
| \`inv.approve\`, \`inv.reject\`, \`inv.attach_data\` | The proposal verbs; \`wait_for_approval()\` blocks until a reviewer decides. |

## Workbooks

Each project lives in one workbook, \`<project>.ap-workbook\`, a SQLite file. Records are appended to a hash-chained log under the daemon's validation and proposal rules, so the SDK, a second process and this workbench can all write the same file. The Rust and Python SDKs implement the same format.

## Muse Code plugin

The plugin runs a local MCP server next to your simulator, so Muse can drive the calibration while the numerical work stays in the SDK.

\`\`\`sh
pip install -e 'sdks/python[mcp]'
muse plugins install plugins/muse-autophys
python -m autophys.cli mcp --project mypkg.module:project --workbook ~/autophys
\`\`\`

Tools: \`describe_project\`, \`import_measurements\`, \`fit\`, \`identifiability\`, \`rank_experiments\`, \`propose_experiment\`, \`status\`, \`attach_data\` and \`report\`. There is no approve or reject tool: experiments are approved here, in the browser.

## The workbench

Open the workbench from the top of this page. The sidebar lists projects and their investigations; the main pane draws measured data, parameter estimates and sensitivity; the details panel shows the selected record. The workbench reads the daemon's recorded investigation and updates live as records arrive.

It does not draw the fitted curve yet; use the battery example for curves.

## Repository map

| Path | What it is |
| --- | --- |
| \`examples/battery_fit\` | Fit a measured battery trace, check identifiability, plot the curve. |
| \`sdks/python\` | Python SDK: simulator, fit, identifiability, experiment ranking, agent loop, workbook. |
| \`sdks/rust\` | Rust SDK. |
| \`plugins/muse-autophys\` | Muse Code plugin (local MCP server). |
| \`src/\`, \`html/\` | Rust daemon and this browser workbench. |
| \`autophys.project.docs\` | Design notes and decisions. |
`;

/** std-documentation sizes type with Lona's cap-height scale, which tento apps get from
 * theme-base.css's :root block. That sheet also styles bare h1-h7, buttons and labels, which
 * would restyle the cookbook, so only its tokens are carried here, scoped to this section, and
 * the colours resolve to the cookbook's. Code colours are tento-ui's light syntax palette
 * (brand/tokens/color/loaf.ts), which Lona apps otherwise get from colors.css. */
const TOKENS = `
  --text-8px: 0.5rem; --text-9px: 0.5625rem; --text-10px: 0.625rem; --text-11px: 0.6875rem;
  --text-12px: 0.75rem; --text-13px: 0.8125rem; --text-14px: 0.875rem; --text-15px: 0.9375rem;
  --text-16px: 1rem; --text-18px: 1.125rem; --text-20px: 1.25rem; --text-22px: 1.375rem;
  --text-24px: 1.5rem; --text-28px: 1.75rem; --text-32px: 2rem;
  --h1-size: var(--text-18px); --h2-size: var(--text-16px); --h3-size: var(--text-14px);
  --h4-size: var(--text-12px); --h5-size: var(--text-12px); --h6-size: var(--text-12px);
  --p-size: var(--text-10px); --caption-size: var(--text-9px); --small-size: var(--text-9px);
  --cap-height: 0.125; --baseline: 0.155;
  --font-size: var(--p-size); --line-height-ratio: 1.4;
  --text-pri: var(--ck-ink, #141414); --text-sec: var(--ck-secondary, #424242); --text-ter: var(--ck-n600, #5c5c5c);
  --divider: var(--ck-line, #d9d9d9); --bg: #fff; --bg-surface: var(--ck-n100, #f7f7f7); --code-bg: var(--ck-n100, #f7f7f7);
  font-family: var(--ck-font, system-ui, sans-serif); color: var(--text-pri);
  --fg-syntax-keyword: #a626a4; --fg-syntax-function: #4078f2; --fg-syntax-string: #50a14f;
  --fg-syntax-number: #986801; --fg-syntax-comment: #a0a1a7; --fg-syntax-punctuation: #696c77;
  --fg-syntax-operator: #0184bc; --fg-syntax-variable: #383a42;
`;

const CSS = `
.ap-landing-docs { ${TOKENS} padding: 96px 20px 112px; background: #fff; border-top: 1px solid var(--ck-line, #d9d9d9); }
@media (min-width: 640px) { .ap-landing-docs { padding-inline: 24px; } }
.ap-landing-docs > std-documentation { display: block; margin: 0 auto; max-width: 800px; }
`;

Code.registerLanguage(["sh", "bash", "shell", "zsh", "console"], shellTokenizer);
Code.registerLanguage(["python", "py"], pythonTokenizer);

/** std-documentation's code block view, drawing with Code's static, tokenizer-coloured path. */
class StaticCodeBlockView {
  dom: Code;
  constructor(node: ProseMirrorEditor.ProseMirrorNode) {
    this.dom = Code.make();
    this.draw(node);
  }
  private draw(node: ProseMirrorEditor.ProseMirrorNode): void {
    void this.dom.bind({ content: node.textContent, language: node.attrs.params || "plain", rendering: "static" });
  }
  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "code_block") return false;
    this.draw(node);
    return true;
  }
  stopEvent(): boolean {
    return true;
  }
  ignoreMutation(): boolean {
    return true;
  }
}

/** Documentation's default views (lisp examples, code blocks), with code blocks drawn statically. */
const NODE_VIEWS: Documentation.Props["nodeViews"] = {
  lisp_example: (node) => new LispExampleView(node),
  code_block: (node) => new StaticCodeBlockView(node),
};

/** The docs section and the shell hook that keeps it out of the open app's tab order. inert,
 * not hidden: onStage runs after the drawer restores the landing's scroll offset, and removing
 * the section from layout first would clamp an offset inside it. */
export function landingDocs(): { onStage(stage: Cookbook.Stage): void; mount(): void } {
  const section = document.createElement("section");
  section.className = "ap-landing-docs";
  section.setAttribute("aria-label", "Documentation");
  return {
    onStage(stage) {
      section.inert = stage !== "landing";
    },
    mount() {
      if (!InstanceUrl.hasStaticBase()) InstanceUrl.setStaticBase("");
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.append(style);
      const doc = Documentation.make();
      section.append(doc);
      const footer = document.querySelector(".ck-footer");
      if (footer) footer.before(section);
      else document.body.append(section);
      void doc.bind({ markdown: DOCS_MARKDOWN, nodeViews: NODE_VIEWS });
    },
  };
}
