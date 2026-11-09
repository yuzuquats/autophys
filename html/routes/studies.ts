/**
 * The landing's case studies and experiments: a section after the documentation, behind the
 * same full-width divider, listing what has been run and what has not. Sources:
 * autophys.project.docs/content/examples.md (the backtests, "Live checks" 2026-11-07), the
 * discovery-harness record (the Muse Spark 1.3 pass the deck's evidence slide draws) and
 * decisions.md (POS-4: the candidates are an agent proposal, pending operator review).
 * A run study states only what its record shows; a candidate states why it suits autophys and
 * what is missing before it can run, and claims no result.
 *
 * Each study is a feature row: a small drawing from studies-visuals.ts, then its status, title and
 * question, then its result or needs. Only the discovery drawing plots recorded data; the others
 * are schematics, and their captions say so.
 *
 * A run study may name its demo workbook as a deep link (decisions.md DL-1). After mount the page
 * probes each link with HEAD and adds "Open in workbench" only when the daemon answers 2xx, so a
 * workbook that is not in the demo collection yet, or an install without one, shows no button.
 * The button is the row's last item, so its arrival never moves the row's text.
 */
import type { Cookbook } from "@tento-cookbook/lib.ts";
import { hideOffLanding } from "./docs.ts";
import { CAPTIONS, type StudyId, VISUALS } from "./studies-visuals.ts";

type Study = {
  /** Which drawing in studies-visuals.ts illustrates it. */
  visual: StudyId;
  title: string;
  status: string;
  /** Well suited to autophys and not run yet: drawn highlighted. */
  candidate?: boolean;
  question: string;
  rows: [string, string][];
  /** A `/open/...` deep link (src/open.rs) to the study's demo workbook. */
  link?: string;
};

const RUN: Study[] = [
  {
    visual: "bat",
    title: "Battery cell, 1RC",
    status: "Run · live models",
    question: "A short pulse fits the voltage curve but cannot separate R1 from C1. Does the loop notice, and ask for the test that can?",
    rows: [
      ["Result", "Muse Spark 1.3 and Muse Wonder 1.0 each passed 8 of 8 live runs; the offline scripted policy passed 8 of 8 too. On the recorded cell each asked for the 1 A discharge; worst parameter error 1.07%."],
      ["Caveat", "The recorded runs are synthesized from the model, not measured. Scripted did as well as the models."],
    ],
    link: "/open/demo/workbook/battery_cycler_demo",
  },
  {
    visual: "disc",
    title: "Model discovery, six hidden cases",
    status: "Experimental · one seed",
    question: "When the model itself is wrong, can an agent refine its structure without claiming what the data cannot support?",
    rows: [
      ["Result", "Muse Spark 1.3 found the planted lag and made no wrong claim; calibration alone made one. The code refused 11 invalid adopts and demoted the stops the data did not support."],
      ["Caveat", "One seed, not a benchmark, and the discovery package is not in a release yet."],
    ],
  },
  {
    visual: "osc",
    title: "Mass-spring-damper",
    status: "Run · offline",
    question: "A free response fixes only c/m and k/m. Does the loop ask for a forced test to separate the mass?",
    rows: [
      ["Result", "Runs in the offline benchmark with the scripted and fake-reasoner policies, three seeds each."],
      ["Not run", "Live model runs."],
    ],
    link: "/open/demo/workbook/mass_spring_damper_demo",
  },
  {
    visual: "th",
    title: "Thermal RC",
    status: "Run · offline",
    question: "A short heating step pins down heat capacity but barely the thermal resistance. Does the loop ask for a longer one?",
    rows: [
      ["Result", "Runs in the offline benchmark with the scripted and fake-reasoner policies, three seeds each."],
      ["Not run", "Live model runs."],
    ],
    link: "/open/demo/workbook/thermal_rc_demo",
  },
];

const CANDIDATES: Study[] = [
  {
    visual: "lfp",
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
    visual: "bld",
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
    visual: "kin",
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
.ap-studies-rows { margin: 16px 0 0; padding: 0; list-style: none; }
.ap-study { display: grid; grid-template-columns: 176px minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start;
  padding: 24px 0; border-top: 1px solid var(--ck-n200, #ebebeb); }
.ap-study:first-child { border-top: 0; }
.ap-study.ap-candidate { margin-left: -19px; padding-left: 16px; border-left: 3px solid var(--ck-ink, #141414); }
.ap-study-visual { margin: 0; }
.ap-study-visual svg { display: block; overflow: visible; }
.ap-study-visual .ap-wide { display: none; }
.ap-study-visual figcaption { margin-top: 6px; font-size: 11px; line-height: 14px; color: var(--ck-n500, #8a8a8a); }
.ap-study-status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; line-height: 16px; white-space: nowrap;
  color: var(--ck-secondary, #424242); box-shadow: inset 0 0 0 1px var(--ck-line, #d9d9d9); }
.ap-candidate .ap-study-status { background: var(--ck-ink, #141414); color: #fff; box-shadow: none; }
.ap-study h4 { margin: 8px 0 0; font-size: 16px; line-height: 22px; font-weight: 500; letter-spacing: -.01em; }
.ap-study-question { margin: 4px 0 0; font-size: 14px; line-height: 20px; color: var(--ck-secondary, #424242); }
.ap-study dl { display: grid; gap: 10px; margin: 0; }
.ap-study dt { font-size: 12px; line-height: 16px; font-weight: 500; color: var(--ck-n500, #8a8a8a); }
.ap-study dd { margin: 2px 0 0; font-size: 14px; line-height: 20px; }
.ap-study-open { grid-column: 2 / -1; justify-self: start; display: inline-flex; align-items: center; gap: 6px;
  min-height: 32px; margin-top: -8px; padding: 6px 12px; border-radius: 8px; font-size: 13px; line-height: 20px; font-weight: 500;
  color: var(--ck-ink, #141414); text-decoration: none; box-shadow: inset 0 0 0 1px var(--ck-line, #d9d9d9); }
.ap-study-open[hidden] { display: none; }
.ap-study-open:hover { background: var(--ck-n100, #f5f5f5); }
.ap-study-open:focus-visible { outline: 2px solid var(--ck-ink, #141414); outline-offset: 2px; }
.ap-study-open svg { flex: none; }
@media (pointer: coarse) { .ap-study-open { min-height: 44px; } }
@media (max-width: 719px) {
  .ap-study { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .ap-study-visual .ap-narrow { display: none; }
  .ap-study-visual .ap-wide { display: block; width: 100%; height: auto; }
  .ap-study-open { grid-column: 1; margin-top: -2px; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** One drawing at a fixed size. The markup is this module's own constant output, not user data. */
function drawing(study: Study, w: number, h: number, className: string): string {
  return `<svg class="${className}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">${VISUALS[study.visual](w, h)}</svg>`;
}

function row(study: Study): HTMLElement {
  const item = el("li", study.candidate ? "ap-study ap-candidate" : "ap-study");
  // The narrow drawing sits in the visual column; the wide one replaces it when the row stacks.
  const visual = el("figure", "ap-study-visual");
  visual.innerHTML = drawing(study, 176, 72, "ap-narrow") + drawing(study, 340, 96, "ap-wide");
  visual.append(el("figcaption", "", CAPTIONS[study.visual]));
  const text = el("div", "");
  text.append(el("span", "ap-study-status", study.status), el("h4", "", study.title), el("p", "ap-study-question", study.question));
  const details = el("dl", "");
  for (const [term, detail] of study.rows) {
    const pair = el("div", "");
    pair.append(el("dt", "", term), el("dd", "", detail));
    details.append(pair);
  }
  item.append(visual, text, details);
  if (study.link) {
    // Shown by probe() once the daemon says the workbook can be opened.
    const open = el("a", "ap-study-open", "Open in workbench");
    open.href = study.link;
    open.hidden = true;
    open.setAttribute("aria-label", `Open ${study.title} in the workbench`);
    open.insertAdjacentHTML("beforeend", `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
    item.append(open);
  }
  return item;
}

/** Reveal each deep-link button whose HEAD answers 2xx; anything else leaves it hidden. */
function probe(section: HTMLElement): void {
  for (const open of section.querySelectorAll<HTMLAnchorElement>("a.ap-study-open")) {
    void fetch(open.href, { method: "HEAD", credentials: "same-origin", cache: "no-store", redirect: "manual",
      signal: AbortSignal.timeout(10_000) })
      .then(response => { if (response.ok) open.hidden = false; })
      .catch(() => { /* No daemon or no network: no button. */ });
  }
}

function group(title: string, lede: string, studies: Study[]): HTMLElement {
  const block = el("div", "ap-studies-group");
  const rows = el("ul", "ap-studies-rows");
  rows.append(...studies.map(row));
  block.append(el("h3", "", title), el("p", "", lede), rows);
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
      probe(section);
    },
  };
}
