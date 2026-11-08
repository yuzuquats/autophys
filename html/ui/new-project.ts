/** Pure New project markup (UI-27, the SDK stepper); the adapter binds the vendored vertical stepper. */
import { escapeHtml as esc } from "./intent.ts";
import { buttonMarkup } from "./actions.ts";
import { actionAttrs } from "./sidebar-markup.ts";
import { blockMarkup } from "./blocks.ts";
import type { ProjectSetupBody, SetupStep } from "./view-model.ts";

export type { ProjectSetupBody } from "./view-model.ts";

/** Element ids of a step's body (focusable, for steps without a control) and its copy button. */
export const setupStepId = (index: number) => `ap-setup-step-${index + 1}`;
export const setupCopyId = (index: number) => `ap-setup-copy-${index + 1}`;

/** Navigation focuses the current step's enabled primary action, else its copy button, else the
 * step itself; never the secondary Back button. */
export function newProjectFocusTarget(model: ProjectSetupBody): string | undefined {
  const index = model.steps.findIndex(step => step.current);
  if (index < 0) return undefined;
  const step = model.steps[index];
  const primary = step.actions.find(action => action.variant === "primary" && !action.disabled);
  if (primary) return `ap-action-${primary.name}`;
  return step.command ? setupCopyId(index) : setupStepId(index);
}

function stepMarkup(step: SetupStep, index: number): string {
  const choice = step.choice ? `<div class="ap-setup-choice" role="group" aria-label="${esc(step.choice.label)}">${step.choice.options.map(o =>
    `<button type="button" class="ap-setup-option" aria-pressed="${o.pressed}" ${actionAttrs(o)}>${esc(o.label)}</button>`).join("")}</div>` : "";
  const command = step.command ? `<div class="ap-code-head"><b>${esc(step.command.label)}</b><span data-ap-copy="${esc(step.command.text)}" data-ap-copy-label="Copy" data-ap-copy-target="${setupStepId(index)}-code"><button type="button" id="${setupCopyId(index)}">Copy</button></span></div><pre class="ap-code ap-setup-command" id="${setupStepId(index)}-code" tabindex="0" aria-label="${esc(step.command.label)}"><code>${esc(step.command.text)}</code></pre>` : "";
  const waiting = step.waiting ? `<p class="ap-setup-waiting" role="status"><span class="ap-setup-dot" aria-hidden="true"></span>${esc(step.waiting)}</p>` : "";
  const actions = step.actions.length ? `<div class="ap-setup-actions">${step.actions.map(a => `<span data-ap-action="${a.variant ?? "secondary"}">${buttonMarkup(a, {})}</span>`).join("")}</div>` : "";
  return `<section data-ap-step data-done="${step.done}" data-current="${step.current}"><h3>${esc(step.title)}</h3><div data-ap-step-body id="${setupStepId(index)}" tabindex="-1"><p class="ap-help">${esc(step.description)}</p>${choice}${command}${waiting}${step.blocks.map(blockMarkup).join("")}${actions}</div></section>`;
}

export function newProjectMarkup(model: ProjectSetupBody): string {
  return `<section class="ap-viewer ap-project-setup"><h2>${esc(model.title)}</h2><p class="ap-intro">${esc(model.description)}</p>${model.notice ? `<p class="ap-text ap-t-danger" role="alert">${esc(model.notice)}</p>` : ""}<div data-ap-stepper>${model.steps.map(stepMarkup).join("")}</div></section>`;
}
