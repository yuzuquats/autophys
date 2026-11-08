import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { newProjectFocusTarget, newProjectMarkup, type ProjectSetupBody } from "./new-project.ts";

const model = (): ProjectSetupBody => ({
  kind: "project-setup", title: "New project", description: "Bring your own simulator.",
  steps: [
    { title: "Create the project", done: false, current: true, description: "Run these",
      choice: { label: "Language", options: [{ name: "setup-lang:python", label: "Python", pressed: true }, { name: "setup-lang:rust", label: "Rust", pressed: false }] },
      command: { label: "Terminal", text: "autophys new my-project --lang python\ncd my-project" },
      blocks: [], actions: [{ name: "setup-next", label: "I've done this", variant: "primary" }] },
    { title: "Connect it", done: false, current: false, description: "Pair", blocks: [], actions: [] },
  ],
});

Deno.test("SDK stepper navigation focuses the enabled primary action of the current step", () => {
  assertEquals(newProjectFocusTarget(model()), "ap-action-setup-next");
});
Deno.test("SDK stepper navigation falls back to the copy button, then the step, never Back", () => {
  const body = model();
  body.steps[0].actions[0].disabled = true;
  assertEquals(newProjectFocusTarget(body), "ap-setup-copy-1");
  body.steps[0].current = false;
  body.steps[1] = { ...body.steps[1], current: true, actions: [{ name: "setup-back", label: "Back" }] };
  assertEquals(newProjectFocusTarget(body), "ap-setup-step-2");
  body.steps[1].current = false;
  assertEquals(newProjectFocusTarget(body), undefined);
});
Deno.test("SDK stepper markup: pressed language toggle, copyable command, polite waiting status and pairing cards", () => {
  const body = model();
  let html = newProjectMarkup(body);
  assertStringIncludes(html, '<div class="ap-setup-choice" role="group" aria-label="Language">');
  assertStringIncludes(html, 'aria-pressed="true" data-ap="action" data-ap-name="setup-lang:python"');
  assertStringIncludes(html, 'aria-pressed="false" data-ap="action" data-ap-name="setup-lang:rust"');
  assertStringIncludes(html, 'data-ap-copy="autophys new my-project --lang python\ncd my-project" data-ap-copy-label="Copy"');
  assertStringIncludes(html, '<pre class="ap-code ap-setup-command" id="ap-setup-step-1-code"');
  assertStringIncludes(html, '<div data-ap-step-body id="ap-setup-step-1" tabindex="-1">');
  assert(!html.includes("<input"), "no form fields");
  body.steps[0] = { ...body.steps[0], current: false, done: true, choice: undefined, command: undefined, actions: [] };
  body.steps[1] = { ...body.steps[1], current: true, waiting: "Waiting for a device…" };
  html = newProjectMarkup(body);
  assertStringIncludes(html, '<p class="ap-setup-waiting" role="status"><span class="ap-setup-dot" aria-hidden="true"></span>Waiting for a device…</p>');
  body.steps[1] = { ...body.steps[1], waiting: undefined, blocks: [{ kind: "pairing", device: "lab <pc>", client: "autophys-cli", code: "ABCD-1234",
    expiry: { at: "2030-01-01T00:00:00Z", steps: [{ label: "Expires in 10 min", delayMs: 0 }] },
    decision: [{ name: "pair-approve:ABCD1234", label: "Approve device", variant: "primary" }, { name: "pair-deny:ABCD1234", label: "Deny" }] }] };
  html = newProjectMarkup(body);
  assertStringIncludes(html, '<h5>lab &lt;pc&gt;</h5>');
  assertStringIncludes(html, 'id="ap-action-pair-approve:ABCD1234"');
  assert(!html.includes("ap-setup-waiting"));
});
