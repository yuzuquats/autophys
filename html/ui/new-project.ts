/** Pure wizard markup; the adapter binds the vendored vertical stepper. */
import { escapeHtml as esc } from "./intent.ts";
import { buttonMarkup } from "./actions.ts";
import type { Action, Field } from "./view-model.ts";

export type ProjectSetupBody = {
  kind: "project-setup"; notice?: string; title: string; description: string;
  steps: { title: string; done: boolean; current: boolean; description: string; fields: Field[]; actions: Action[] }[];
};
export function newProjectMarkup(model: ProjectSetupBody): string {
  return `<section class="ap-viewer ap-project-setup"><h2>${esc(model.title)}</h2><p class="ap-intro">${esc(model.description)}</p>${model.notice ? `<p class="ap-text ap-t-danger" role="alert">${esc(model.notice)}</p>` : ""}<div data-ap-stepper>${model.steps.map(step =>
    `<section data-ap-step data-done="${step.done}" data-current="${step.current}"><h3>${esc(step.title)}</h3><div data-ap-step-body><p class="ap-help">${esc(step.description)}</p>${step.fields.length ? `<div class="ap-setup-fields">${step.fields.map(f => `<label for="ap-${esc(f.name)}">${esc(f.label)}${f.unit ? ` <span>(${esc(f.unit)})</span>` : ""}<input id="ap-${esc(f.name)}" data-ap="field" data-ap-name="${esc(f.name)}" value="${esc(f.value)}" ${f.name === "setup:name" ? 'type="text" maxlength="120" autocomplete="off"' : 'type="number" step="any"'}></label>`).join("")}</div>` : ""}<div class="ap-setup-actions">${step.actions.map(a => `<span data-ap-action="${a.variant ?? "secondary"}">${buttonMarkup(a, {})}</span>`).join("")}</div></div></section>`
  ).join("")}</div></section>`;
}
