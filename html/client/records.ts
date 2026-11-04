/** Applying a record to a workspace: the one place the store and the fixture source share. */
import type { Rec } from "./api.ts";
import type { Workspace } from "./domain.ts";
import { applyDecision, type Decision } from "./proposal.ts";

/** Where a record points, or null when the workspace has no such proposal. */
export function locate(ws: Workspace, project: string, investigation: string, proposal: string) {
  const p = ws.projects.find((x) => x.id === project);
  const inv = p?.investigations.find((x) => x.id === investigation);
  const prop = inv?.proposals.find((x) => x.id === proposal);
  return p && inv && prop ? { project: p, inv, proposal: prop } : null;
}

/** The workspace after a decision on one proposal (the rest shared), or null when it does not apply. */
export function decide(ws: Workspace, project: string, investigation: string, proposal: string, d: Decision): Workspace | null {
  const at = locate(ws, project, investigation, proposal);
  const next = at && applyDecision(at.proposal, d);
  if (!at || !next) return null;
  const invs = at.project.investigations.map((i) => (i === at.inv ? { ...i, proposals: i.proposals.map((x) => (x === at.proposal ? next : x)) } : i));
  return { ...ws, projects: ws.projects.map((x) => (x === at.project ? { ...x, investigations: invs } : x)) };
}

/** A decision record applied in order; any other record (a daemon record) is the source's own fold. */
export function applyRecord(ws: Workspace, r: Rec): Workspace | null {
  if (r.kind !== "proposal") return null;
  const { project, proposal, ...d } = r.payload;
  return decide(ws, project, r.investigation, proposal, d);
}
