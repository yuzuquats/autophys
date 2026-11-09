/**
 * Deep links (decisions.md DL-1 to DL-3). The daemon answers `/open/{user}/{kind}/{name}`
 * (src/open.rs) and redirects into `/app?open={user}/{kind}/{name}`; this module parses that
 * address, decides what the page must do about the account first, and picks the selection.
 * Pure: no DOM, no network.
 */
import type { Investigation, Project } from "../client/domain.ts";
import { ids } from "../client/derive/shared.ts";

/** The reserved user names src/open.rs serves; anything else is not a link this page opens. */
export const OPEN_USERS = ["demo", "me", "local"] as const;
/** The kinds src/open.rs registers (`KINDS`). */
export const OPEN_KINDS = ["workbook"] as const;

export type OpenAddress = { user: (typeof OPEN_USERS)[number]; kind: (typeof OPEN_KINDS)[number]; name: string };

/** src/open.rs `valid_name`: a slug that stays inside the collection. */
const NAME = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

/** `?open=user/kind/name`, or null when absent or not a link src/open.rs could have issued. */
export function openAddress(search: string): OpenAddress | null {
  const raw = new URLSearchParams(search).get("open");
  if (!raw) return null;
  const parts = raw.split("/");
  if (parts.length !== 3) return null;
  const [user, kind, name] = parts;
  if (!(OPEN_USERS as readonly string[]).includes(user) || !(OPEN_KINDS as readonly string[]).includes(kind)) return null;
  if (!NAME.test(name) || name.includes("..")) return null;
  return { user: user as OpenAddress["user"], kind: kind as OpenAddress["kind"], name };
}

/** What the page knows about its session (the server's AppContext). */
export type OpenSession = {
  /** A principal is resolved: a signed-in account, or the local browser without --login. */
  signedIn: boolean;
  /** The open workspace is the demo account's (`workspace.demo`). */
  demoWorkspace: boolean;
  /** The daemon runs with --login (it offers sign-in or sign-out). */
  login: boolean;
  /** The daemon has a demo account to sign in as. */
  allowDemo: boolean;
};

/**
 * What to do before selecting: open in this session, sign in as the demo first, ask before
 * leaving another account for the demo (DL-3), or drop a link this session cannot open.
 */
export type OpenAccess = "open" | "sign-in-demo" | "confirm-switch" | "drop";

export function openAccess(address: OpenAddress, session: OpenSession): OpenAccess {
  switch (address.user) {
    case "demo":
      if (!session.login) return "drop";
      if (!session.signedIn) return session.allowDemo ? "sign-in-demo" : "drop";
      return session.demoWorkspace ? "open" : "confirm-switch";
    case "me":
      return session.signedIn ? "open" : "drop";
    case "local":
      return session.login ? "drop" : "open";
  }
}

/** The SDKs' workbook slug (sdks/rust/src/client.rs `slug`): links name a project by it. */
export function slug(name: string): string {
  let out = "", run = false;
  for (const c of name.toLowerCase()) {
    if (/^[a-z0-9._-]$/.test(c)) { out += c; run = false; }
    else if (!run) { out += "-"; run = true; }
  }
  return out.replace(/^[-.]+|[-.]+$/g, "") || "project";
}

/**
 * The node a workbook link opens: the project's most recent validated investigation, else its
 * config node. Null when this workspace has no such workbook.
 */
export function openSelection(projects: readonly Project[], address: OpenAddress): { projectId: string; id: string } | null {
  const project = projects.find((p) => p.name === address.name) ?? projects.find((p) => slug(p.name) === address.name);
  if (!project) return null;
  let newest: Investigation | null = null;
  // updatedUtc ("2026-11-04 10:07 UTC") sorts as text; a tie goes to the later record.
  for (const inv of project.investigations) {
    if (inv.state === "validated" && (!newest || (inv.updatedUtc ?? "") >= (newest.updatedUtc ?? ""))) newest = inv;
  }
  return { projectId: project.id, id: newest ? ids.inv(newest) : ids.config(project) };
}

/** `search` without its `open` parameter, keeping every other one (and `?` only when one is left). */
export function withoutOpen(search: string): string {
  const query = new URLSearchParams(search);
  query.delete("open");
  const rest = query.toString();
  return rest ? `?${rest}` : "";
}
