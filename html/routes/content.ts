/**
 * The product copy the cookbook shows around the app: its tutorial steps, which point into
 * the slots by the ui's stable ids and classes. (The cookbook's own steps cover its chrome.)
 */
export const tutorial = [
  { title: "Pick a project", body: "Each project is one simulator and its configuration. The switcher is at the top of the sidebar.", target: ["#ap-switch"] },
  { title: "Open an investigation", body: "Its measurements, fits, sensitivity, proposals and validation are rows under it.", target: ["std-tree-list.ap-tree:not(.ap-pinned)"] },
  { title: "Read a fit", body: "Each fit opens into its views: Fit, Residuals, Landscape and whatever its experiments ask for.", target: [".ap-viewer"] },
  { title: "Decide the next experiment", body: "Edit the proposed settings if you like, then approve or reject it.", target: ["#ap-action-approve", ".ap-decision"] },
] as const;
