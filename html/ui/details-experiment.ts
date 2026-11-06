/// <reference lib="dom" />
/** Proposal-only presentation metadata; the shared DetailsModel remains unchanged. */
import { blockMarkup } from "./blocks.ts";
import { buttonMarkup } from "./actions.ts";
import { ICONS } from "./icons.ts";
import { escapeHtml as esc } from "./intent.ts";
import type { DetailsClasses } from "./details.ts";
import type { DetailsModel } from "./view-model.ts";

export type ExperimentDetailsModel = DetailsModel & {
  experiment: { key: string; caption: string; notice?: string };
};
export type ExperimentRows = Readonly<Record<string, boolean>>;

/** Classify by derived record metadata, never by human-facing status text. */
export function isExperimentDetails(model: DetailsModel): model is ExperimentDetailsModel {
  return model.icon === "proposal" && model.cardName === true && "experiment" in model;
}

function disclosure(key: string, heading: string, body: string, rows: ExperimentRows): string {
  return `<details class="ap-experiment-row" data-ap-experiment-row="${esc(key)}"${rows[key] ? " open" : ""}>
    <summary class="ap-experiment-row-summary"><span>${esc(heading)}</span><span class="ap-experiment-caret" aria-hidden="true">${ICONS.chevron}</span></summary>
    <div class="ap-experiment-row-body">${body}</div>
  </details>`;
}

export function experimentDetailsMarkup(model: ExperimentDetailsModel, classes: DetailsClasses, rows: ExperimentRows): string {
  const name = [classes.name ?? "", "ap-dname"].filter(Boolean).join(" ");
  const status = [classes.status ?? "", "ap-status", model.status.tone ? `ap-t-${model.status.tone}` : ""].filter(Boolean).join(" ");
  // Keep the decision's settings and consequence ahead of supporting disclosures.
  const supporting = new Set(["Preview", "So far"]);
  const sections = model.sections.map(s => ({
    heading: s.heading,
    body: `${s.caption ? `<p class="ap-experiment-caption">${esc(s.caption)}</p>` : ""}${s.blocks.map(blockMarkup).join("")}`,
  }));
  const core = sections.filter(s => !supporting.has(s.heading ?? "")).map(s =>
    `<section class="ap-experiment-section">${s.heading ? `<h4 class="ap-sub">${esc(s.heading)}</h4>` : ""}${s.body}</section>`).join("");
  const extra = sections.filter(s => supporting.has(s.heading ?? "")).map(s => disclosure(s.heading!, s.heading!, s.body, rows)).join("");
  const provenance = model.footnote ? disclosure("provenance", "Provenance", `<p class="ap-footnote">${esc(model.footnote)}</p>`, rows) : "";
  const decision = model.decision ? `<div class="${esc([classes.decision ?? "", "ap-decision"].filter(Boolean).join(" "))}">${model.decision.map(a => buttonMarkup(a, classes)).join("")}</div>` : "";
  const actions = model.actions?.length ? `<div class="ap-actions${model.actions.length === 1 ? " ap-one" : ""}">${model.actions.map(a => buttonMarkup(a, classes)).join("")}</div>` : "";
  return `<section class="ap-experiment-card" aria-labelledby="ap-experiment-name">
    <std-round floating bg="var(--bg,#fff)" border="var(--ap-line)" radius="12"></std-round>
    <header class="ap-experiment-header" data-ap-cell>
      <h3 id="ap-experiment-name" class="${esc(name)}" ${classes.cardNameAttribute ?? "data-card-name"}>${ICONS[model.icon]}<span>${esc(model.title)}</span></h3>
      <p class="ap-experiment-source" id="ap-experiment-source">${esc(model.experiment.caption)}</p>
      <p class="${esc(status)}" id="ap-status" role="status">${esc(model.status.text)}</p>
    </header>
    <div class="ap-experiment-body">${core}</div>
    ${model.experiment.notice ? `<section class="ap-experiment-notice" role="alert"><h4 class="ap-sub">Not saved</h4>${blockMarkup({ kind: "text", text: model.experiment.notice, tone: "danger" })}</section>` : ""}
    ${decision || actions ? `<footer class="ap-experiment-actions">${decision}${actions}</footer>` : ""}
    ${extra}${provenance}
  </section>`;
}
