import { assertEquals } from "jsr:@std/assert@1";
import { newProjectFocusTarget, type ProjectSetupBody } from "./new-project.ts";

const model = (): ProjectSetupBody => ({
  kind: "project-setup", title: "New project", description: "",
  steps: [{ title: "Parameters", done: false, current: true, description: "",
    fields: [{ name: "setup:c", label: "Heat capacity C", value: "400", unit: "J/K" }],
    actions: [{ name: "setup-back", label: "Back" }, { name: "setup-create", label: "Create project", variant: "primary" }],
  }],
});

Deno.test("wizard navigation focuses the first field before either action", () => {
  assertEquals(newProjectFocusTarget(model()), "ap-setup:c");
});
Deno.test("wizard navigation uses an enabled primary action when there are no fields", () => {
  const body = model();
  body.steps[0].fields = [];
  assertEquals(newProjectFocusTarget(body), "ap-action-setup-create");
  body.steps[0].actions[1].disabled = true;
  assertEquals(newProjectFocusTarget(body), undefined);
  body.steps[0].actions = [body.steps[0].actions[0]];
  assertEquals(newProjectFocusTarget(body), undefined);
});
Deno.test("wizard navigation ignores fields and actions outside the current step", () => {
  const body = model();
  body.steps[0].current = false;
  assertEquals(newProjectFocusTarget(body), undefined);
  body.steps.push({ ...body.steps[0], current: true, fields: [], actions: [{ name: "setup-start", label: "Start investigation", variant: "primary" }] });
  assertEquals(newProjectFocusTarget(body), "ap-action-setup-start");
});
