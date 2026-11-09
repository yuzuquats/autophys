/**
 * The landing's case studies and experiments: a section after the documentation, behind the
 * same full-width divider, listing what has been run and what has not. Sources:
 * autophys.project.docs/content/examples.md (the backtests, "Live checks" 2026-11-07), the
 * discovery-harness record (the Muse Spark 1.3 pass the deck's evidence slide draws) and
 * decisions.md (POS-4: the candidates are an agent proposal, pending operator review).
 * A run study states only what its record shows; a candidate states why it suits autophys and
 * what is missing before it can run, and claims no result.
 */
import type { Cookbook } from "@tento-cookbook/lib.ts";
import { hideOffLanding } from "./docs.ts";

type Study = {
  title: string;
  status: string;
  /** Well suited to autophys and not run yet: drawn highlighted. */
  candidate?: boolean;
  question: string;
  rows: [string, string][];
};

const RUN: Study[] = [
  {
    title: "Battery cell, 1RC",
    status: "Run · live models",
    question: "A short pulse fits the voltage curve but cannot separate R1 from C1. Does the loop notice, and ask for the test that can?",
    rows: [
      ["Result", "Scripted, Muse Spark 1.3 and Muse Wonder 1.0 each passed 8 of 8 live runs. On the recorded cell each asked for the 1 A discharge; worst parameter error 1.07%."],
      ["Caveat", "The recorded runs are synthesized from the model, not measured. Scripted did as well as the models."],
    ],
  },
  {
    title: "Model discovery, six hidden cases",
    status: "Experimental · one seed",
    question: "When the model itself is wrong, can an agent refine its structure without claiming what the data cannot support?",
    rows: [
      ["Result", "Muse Spark 1.3 found the planted lag and made no wrong claim; calibration alone made one. The code refused two invalid adopts and one unproven stop."],
      ["Caveat", "One seed, not a benchmark, and the discovery package is not in a release yet."],
    ],
  },
  {
    title: "Mass-spring-damper",
    status: "Run · offline",
    question: "A free response fixes only c/m and k/m. Does the loop ask for a forced test to separate the mass?",
    rows: [
      ["Result", "Runs in the offline benchmark with the scripted and heuristic policies, three seeds each."],
      ["Not run", "Live model runs."],
    ],
  },
  {
    title: "Thermal RC",
    status: "Run · offline",
    question: "A short heating step pins down heat capacity but barely the thermal resistance. Does the loop ask for a longer one?",
    rows: [
      ["Result", "Runs in the offline benchmark with the scripted and heuristic policies, three seeds each."],
      ["Not run", "Live model runs."],
    ],
  },
];

const CANDIDATES: Study[] = [
  {
    title: "Lithium-iron cells across temperature",
    status: "Not run · good fit",
    candidate: true,
    question: "Characterize a cell at several temperatures with fewer long pulse-and-rest programs.",
    rows: [
      ["Why it fits", "Each program takes hours, most of it resting, and is repeated per temperature. Short pulses leave R1 and C1 confounded, the case the battery backtest already covers."],
      ["Needed", "Measured cycler data we may publish, and a temperature-dependent cell model."],
    ],
  },
  {
    title: "Building thermal envelope",
    status: "Not run · good fit",
    candidate: true,
    question: "Identify a room's heat capacity and its resistance to outside from as few heating tests as possible.",
    rows: [
      ["Why it fits", "Each heating step takes hours to days, and a short one fixes capacity but not resistance, as in the thermal backtest."],
      ["Needed", "A two-node thermal model and logged room, heater and outdoor temperatures."],
    ],
  },
  {
    title: "Reaction kinetics",
    status: "Not run · good fit",
    candidate: true,
    question: "Separate a reaction's rate constant from diffusion, then fit how it changes with temperature.",
    rows: [
      ["Why it fits", "One batch rarely separates rate from transport, each new condition costs a batch, and a few named parameters carry the physics."],
      ["Needed", "A kinetics simulator for the model registry and recorded batch runs."],
    ],
  },
];

const CSS = `
.ap-landing-studies { padding: 96px 20px 112px; background: #fff; border-top: 1px solid var(--ck-line, #d9d9d9);
  font-family: var(--ck-font, system-ui, sans-serif); color: var(--ck-ink, #141414); }
@media (min-width: 640px) { .ap-landing-studies { padding-inline: 24px; } }
.ap-studies { margin: 0 auto; max-width: 800px; }
.ap-studies h2 { margin: 0; font-size: 28px; line-height: 36px; font-weight: 500; letter-spacing: -.02em; }
.ap-studies-lede { margin: 12px 0 0; max-width: 62ch; font-size: 16px; line-height: 24px; color: var(--ck-secondary, #424242); }
.ap-studies-group { margin-top: 56px; }
.ap-studies-group h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.ap-studies-group > p { margin: 4px 0 0; max-width: 62ch; font-size: 14px; line-height: 20px; color: var(--ck-n600, #5c5c5c); }
.ap-studies-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 16px; margin: 20px 0 0; padding: 0; list-style: none; }
.ap-study { display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--ck-line, #d9d9d9); }
.ap-study.ap-candidate { box-shadow: inset 0 0 0 1.5px var(--ck-ink, #141414); }
.ap-study-status { align-self: flex-start; padding: 2px 8px; border-radius: 999px; font-size: 12px; line-height: 16px;
  color: var(--ck-secondary, #424242); box-shadow: inset 0 0 0 1px var(--ck-line, #d9d9d9); }
.ap-candidate .ap-study-status { background: var(--ck-ink, #141414); color: #fff; box-shadow: none; }
.ap-study h4 { margin: 0; font-size: 16px; line-height: 22px; font-weight: 500; letter-spacing: -.01em; }
.ap-study-question { margin: -4px 0 0; font-size: 14px; line-height: 20px; color: var(--ck-secondary, #424242); }
.ap-study dl { display: grid; gap: 10px; margin: 4px 0 0; padding-top: 12px; border-top: 1px solid var(--ck-n200, #ebebeb); }
.ap-study dt { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--ck-n500, #8a8a8a); }
.ap-study dd { margin: 2px 0 0; font-size: 14px; line-height: 20px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function card(study: Study): HTMLElement {
  const item = el("li", study.candidate ? "ap-study ap-candidate" : "ap-study");
  const rows = el("dl", "");
  for (const [term, detail] of study.rows) {
    const row = el("div", "");
    row.append(el("dt", "", term), el("dd", "", detail));
    rows.append(row);
  }
  item.append(el("span", "ap-study-status", study.status), el("h4", "", study.title), el("p", "ap-study-question", study.question), rows);
  return item;
}

function group(title: string, lede: string, studies: Study[]): HTMLElement {
  const block = el("div", "ap-studies-group");
  const grid = el("ul", "ap-studies-grid");
  grid.append(...studies.map(card));
  block.append(el("h3", "", title), el("p", "", lede), grid);
  return block;
}

export function landingStudies(): { onStage(stage: Cookbook.Stage): void; mount(): void } {
  const section = el("section", "ap-landing-studies");
  section.id = "studies";
  section.setAttribute("aria-label", "Case studies and experiments");
  return {
    onStage(stage) {
      hideOffLanding(section, stage);
    },
    mount() {
      const style = el("style", "");
      style.textContent = CSS;
      document.head.append(style);
      const inner = el("div", "ap-studies");
      inner.append(
        el("h2", "", "Case studies and experiments"),
        el("p", "ap-studies-lede", "What has been run, with what it showed, and what has not been run yet. Autophys suits a physical model with a few named parameters, tests that cost hours or days, and parameters an easy test cannot tell apart."),
        group("Run", "Backtests against a hidden truth, and one experimental pass.", RUN),
        group("Not run yet: good fits", "Candidates we think suit Autophys. None has a result yet; each names what it needs first.", CANDIDATES),
      );
      section.append(inner);
      const footer = document.querySelector(".ck-footer");
      if (footer) footer.before(section);
      else document.body.append(section);
    },
  };
}
