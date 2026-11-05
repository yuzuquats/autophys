/** Server bootstrap and refresh share one presentation contract. */
export type Capabilities = { read: boolean; createProject: boolean; startInvestigation: boolean; approveProposal: boolean; manageDevices: boolean };
export type AppContext = {
  principal: { id: string; displayName: string; email?: string; avatarUrl?: string } | null;
  workspace: { id: string } | null;
  capabilities: Capabilities;
  auth: { canSignIn: boolean; canSignOut: boolean; allowDemo: boolean };
};
export function bootstrapContext(): AppContext | null {
  const value = document.getElementById("ap-context")?.textContent;
  if (!value) return null;
  try { return JSON.parse(value) as AppContext; } catch { return null; }
}
export async function readContext(): Promise<AppContext> {
  const r = await fetch("/api/v1/context", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error("Couldn't resolve your workspace. Reload to try again.");
  return r.json();
}
