/** Capability presentation and controller guards use the same operation names. */
import type { Capabilities } from "./context.ts";
import type { View } from "./derive/index.ts";
import type { Action, Block, Section } from "../ui/view-model.ts";
import type { Intent } from "../ui/intent.ts";

export function canAct(name: string, c: Capabilities): boolean {
  if (name === "new-project" || name.startsWith("setup-")) return c.createProject;
  if (/^pair-(approve|deny):/.test(name) || name === "lookup-pairing") return c.manageDevices;
  if (/^(approve|reject|withdraw|restore)$/.test(name)) return c.approveProposal;
  return true;
}
export function canHandle(intent: Intent, c: Capabilities): boolean {
  return intent.kind === "action" ? canAct(intent.name, c) : intent.kind !== "field" || (intent.name === "pairing-code" ? c.manageDevices : c.approveProposal);
}
export function accessibleView(view: View, c: Capabilities): View {
  const action = (a: Action): Action => canAct(a.name, c) ? a : { ...a, disabled: true, title: "Your account has read-only access." };
  const pair = (a: [Action, Action]): [Action, Action] => [action(a[0]), action(a[1])];
  const block = (b: Block): Block => b.kind === "pairing" ? { ...b, decision: pair(b.decision) }
    : b.kind === "fields" && !c.approveProposal ? { kind: "facts", rows: b.fields.map(f => ({ label: f.label, value: f.value + (f.unit ? ` ${f.unit}` : "") })) } : b;
  const section = (s: Section): Section => ({ ...s, blocks: s.blocks.map(b => s.heading === "Devices" && b.kind === "text" && !c.manageDevices
    ? { ...b, text: "Connecting a device requires write access to this workspace." } : block(b)) });
  let body = view.main.body;
  if (body.kind === "decision") body = { ...body, cards: body.cards.map(section) };
  if (body.kind === "project-setup") body = { ...body, steps: body.steps.map(step => ({ ...step, blocks: step.blocks.map(block), actions: step.actions.map(action),
    choice: step.choice && { ...step.choice, options: step.choice.options.map(o => ({ ...action(o), pressed: o.pressed })) } })) };
  if (body.kind === "empty" && !c.createProject) body = { ...body, text: "This workspace has no projects yet. Your account has read-only access; projects will appear when its owner adds them." };
  return { ...view,
    sidebar: { ...view.sidebar, readOnly: !c.createProject, notice: view.sidebar.notice?.kind === "no-projects" && !c.createProject ? { ...view.sidebar.notice, description: "Projects will appear when the workspace owner adds them." } : view.sidebar.notice },
    main: { ...view.main, body, actions: view.main.actions.map(action) },
    details: { ...view.details, status: view.details.icon === "device" && !c.manageDevices ? { text: "Read-only" } : view.details.status, sections: view.details.sections.map(section), decision: view.details.decision && pair(view.details.decision), actions: view.details.actions?.map(action), footnote: !c.createProject ? "Read-only access" : view.details.footnote },
  };
}
