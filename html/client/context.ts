/** Server bootstrap and refresh share one presentation contract. */
export type Capabilities = { read: boolean; createProject: boolean; startInvestigation: boolean; approveProposal: boolean; manageDevices: boolean };
export type AppContext = {
  principal: { id: string; displayName: string; email?: string; avatarUrl?: string } | null;
  workspace: { id: string; demo?: boolean } | null;
  capabilities: Capabilities;
  auth: { canSignIn: boolean; canSignOut: boolean; allowDemo: boolean };
};
