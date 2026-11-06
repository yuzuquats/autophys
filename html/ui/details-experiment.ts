/// <reference lib="dom" />
/** Proposal-only presentation metadata; the shared DetailsModel remains unchanged. */
import { blockMarkup } from "./blocks.ts";
import { buttonMarkup } from "./actions.ts";
import { ICONS } from "./icons.ts";
import { escapeHtml as esc } from "./intent.ts";
import type { DetailsClasses } from "./details.ts";
import type { Crumb, DetailsModel, ExperimentHeader } from "./view-model.ts";

export type ExperimentDetailsModel = DetailsModel & {
  experiment: { key: string; caption: string; header?: ExperimentHeader; notice?: string };
};
export type ExperimentRows = Readonly<Record<string, boolean>>;

function recordLink(crumb: Crumb): string {
  return crumb.id
    ? `<button type="button" class="ap-experiment-link" data-ap="select" data-ap-id="${esc(crumb.id)}">${esc(crumb.label)}</button>`
    : `<span>${esc(crumb.label)}</span>`;
}

/** One clipboard silhouette; its interior mark distinguishes review outcomes. */
function reviewIcon(state: ExperimentHeader["state"]): string {
  const mark = state === "pending"
    ? '<circle cx="7" cy="12" r=".75" fill="currentColor" stroke="none"/><circle cx="10" cy="12" r=".75" fill="currentColor" stroke="none"/><circle cx="13" cy="12" r=".75" fill="currentColor" stroke="none"/>'
    : state === "approved" ? '<path d="m7 11.5 2 2 4-4"/>' : '<path d="m8 9.5 4 4m0-4-4 4"/>';
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 3.5h-1a1.5 1.5 0 0 0-1.5 1.5v11a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 16V5a1.5 1.5 0 0 0-1.5-1.5h-1"/><rect x="7" y="2" width="6" height="3" rx="1"/>${mark}</svg>`;
}

function headerMarkup(model: ExperimentDetailsModel, name: string, status: string, classes: DetailsClasses): string {
  const h = model.experiment.header;
  const title = `<h3 id="ap-experiment-name" class="${esc(name)}" ${classes.cardNameAttribute ?? "data-card-name"}>${!h ? ICONS[model.icon] : ""}<span>${esc(model.title)}</span></h3>`;
  if (!h) return `${title}<p class="ap-experiment-source" id="ap-experiment-source">${esc(model.experiment.caption)}</p><p class="${esc(status)}" id="ap-status" role="status">${esc(model.status.text)}</p>`;
  return `<nav class="ap-experiment-breadcrumb" id="ap-experiment-source" aria-label="Proposal location"><ol>
    <li>${recordLink(h.investigation)}</li><li><span class="ap-experiment-separator" aria-hidden="true">›</span><span aria-current="page">${esc(h.proposal)}</span></li>
  </ol></nav>
  <div class="ap-experiment-title-row">${title}
    <span class="ap-review-control" data-state="${esc(h.state)}"><input type="button" class="ap-review-status" data-state="${esc(h.state)}" value="" popovertarget="ap-review-status-popover" aria-label="${esc(model.status.text)}" title="${esc(model.status.text)}">${reviewIcon(h.state)}</span>
    <div class="ap-review-tooltip" id="ap-review-status-popover" popover>${esc(model.status.text)}</div>
    ${h.state === "pending" ? `<span class="ap-review-announcement" id="ap-status" role="status">${esc(model.status.text)}</span>` : ""}
  </div>
  <p class="ap-experiment-fit">Ranked at ${recordLink(h.sourceFit)}</p>`;
}


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
  const receipt = model.experiment.header && model.experiment.header.state !== "pending" ? `<p class="ap-experiment-receipt" id="ap-status" role="status">${esc(model.status.text)}</p>` : "";
  const actions = model.actions?.length ? `<div class="ap-actions${model.actions.length === 1 ? " ap-one" : ""}">${model.actions.map(a => buttonMarkup(a, classes)).join("")}</div>` : "";
  return `<section class="ap-experiment-card" data-ap-experiment-key="${esc(model.experiment.key)}" aria-labelledby="ap-experiment-name">
    <std-round floating bg="var(--bg,#fff)" border="var(--ap-line)" radius="12"></std-round>
    <header class="ap-experiment-header" data-ap-cell>
      ${headerMarkup(model, name, status, classes)}
    </header>
    <div class="ap-experiment-scroll">
      ${sections}${provenance}
    </div>
    ${decision || actions || receipt || model.experiment.notice ? `<footer class="ap-experiment-actions">
      ${model.experiment.notice ? `<section class="ap-experiment-notice" role="alert"><h4 class="ap-sub">Not saved</h4>${blockMarkup({ kind: "text", text: model.experiment.notice, tone: "danger" })}</section>` : ""}
      ${receipt}${decision}${actions}
    </footer>` : ""}
  </section>`;
}
