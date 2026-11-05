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

/** Classify by derived record metadata, never by human-facing status text. */
export function isExperimentDetails(model: DetailsModel): model is ExperimentDetailsModel {
  return model.icon === "proposal" && model.cardName === true && "experiment" in model;
}

export function experimentDetailsMarkup(model: ExperimentDetailsModel, classes: DetailsClasses, open: boolean): string {
  const name = [classes.name ?? "", "ap-dname"].filter(Boolean).join(" ");
  const status = [classes.status ?? "", "ap-status", model.status.tone ? `ap-t-${model.status.tone}` : ""].filter(Boolean).join(" ");
  const sections = model.sections.map(s => `<section class="ap-experiment-section">${s.heading ? `<h4 class="ap-sub">${esc(s.heading)}</h4>` : ""}${s.caption ? `<p class="ap-experiment-caption">${esc(s.caption)}</p>` : ""}${s.blocks.map(blockMarkup).join("")}</section>`).join("");
  const decision = model.decision ? `<div class="${esc([classes.decision ?? "", "ap-decision"].filter(Boolean).join(" "))}">${model.decision.map(a => buttonMarkup(a, classes)).join("")}</div>` : "";
  const actions = model.actions?.length ? `<div class="ap-actions${model.actions.length === 1 ? " ap-one" : ""}">${model.actions.map(a => buttonMarkup(a, classes)).join("")}</div>` : "";
  return `<section class="ap-experiment-card">
    <details data-ap-experiment${open ? " open" : ""}>
      <summary class="ap-experiment-summary" aria-labelledby="ap-experiment-name" aria-describedby="ap-status ap-experiment-source">
        <div data-ap-cell>
          <h3 id="ap-experiment-name" class="${esc(name)}" ${classes.cardNameAttribute ?? "data-card-name"}>${ICONS[model.icon]}<span>${esc(model.title)}</span></h3>
          <p class="ap-experiment-source" id="ap-experiment-source">${esc(model.experiment.caption)}</p>
          <p class="${esc(status)}" id="ap-status" role="status">${esc(model.status.text)}</p>
        </div>
        <span class="ap-experiment-caret" aria-hidden="true">${ICONS.chevron}</span>
      </summary>
      <div class="ap-experiment-body">${sections}${model.footnote ? `<p class="ap-footnote">${esc(model.footnote)}</p>` : ""}</div>
    </details>
    ${model.experiment.notice ? `<section class="ap-experiment-notice" role="alert"><h4 class="ap-sub">Not saved</h4>${blockMarkup({ kind: "text", text: model.experiment.notice, tone: "danger" })}</section>` : ""}
    ${decision || actions ? `<footer class="ap-experiment-actions">${decision}${actions}</footer>` : ""}
  </section>`;
}
