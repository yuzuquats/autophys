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

function disclosure(key: string, heading: string, body: string, rows: ExperimentRows, defaultOpen = false): string {
  return `<details class="ap-experiment-row" data-ap-experiment-row="${esc(key)}"${(rows[key] ?? defaultOpen) ? " open" : ""}>
    <summary class="ap-experiment-row-summary"><span>${esc(heading)}</span><span class="ap-experiment-caret" aria-hidden="true">${ICONS.chevron}</span></summary>
    <div class="ap-experiment-row-body">${body}</div>
  </details>`;
}

export function experimentDetailsMarkup(model: ExperimentDetailsModel, classes: DetailsClasses, rows: ExperimentRows): string {
  const name = [classes.name ?? "", "ap-dname"].filter(Boolean).join(" ");
  const status = [classes.status ?? "", "ap-status", model.status.tone ? `ap-t-${model.status.tone}` : ""].filter(Boolean).join(" ");
  // One flat accordion in the middle; every named section owns its disclosure.
  // Keep editable settings and the expected result open on first review.
  const supporting = new Set(["Preview", "So far"]);
  const sections = [
    ...model.sections.filter(s => !supporting.has(s.heading ?? "")),
    ...model.sections.filter(s => supporting.has(s.heading ?? "")),
  ].map(s => {
    const body = `${s.caption ? `<p class="ap-experiment-caption">${esc(s.caption)}</p>` : ""}${s.blocks.map(blockMarkup).join("")}`;
    return s.heading
      ? disclosure(s.heading, s.heading, body, rows, !supporting.has(s.heading))
      : `<div class="ap-experiment-row-body">${body}</div>`;
  }).join("");
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
    <div class="ap-experiment-scroll">
      ${sections}${provenance}
    </div>
    ${decision || actions || model.experiment.notice ? `<footer class="ap-experiment-actions">
      ${model.experiment.notice ? `<section class="ap-experiment-notice" role="alert"><h4 class="ap-sub">Not saved</h4>${blockMarkup({ kind: "text", text: model.experiment.notice, tone: "danger" })}</section>` : ""}
      ${decision}${actions}
    </footer>` : ""}
  </section>`;
}
