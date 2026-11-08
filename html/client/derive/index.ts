/** Snapshot + selection → the three view-only surfaces, including explicit null states. */
import type { Snapshot } from "../api.ts";
import type { Pairing } from "../domain.ts";
import type { DetailsModel, MainModel, SidebarModel } from "../../ui/view-model.ts";
import { detailsModel, devices } from "./details.ts";
import { mainModel } from "./main.ts";
import { onboarding } from "./onboarding.ts";
import type { Selection } from "./shared.ts";
import { sidebarModel, devicesNode } from "./tree.ts";

export type View = { sidebar: SidebarModel; main: MainModel; details: DetailsModel };

export function empty(source: string, pairings?: Pairing[], notice?: string): View {
  const base = loading(source), dev = devices({ pairings: pairings ?? [] });
  return {
    sidebar: { ...base.sidebar, switcher: { ...base.sidebar.switcher, kind: "none" },
      notice: { kind: "no-projects", title: "No projects yet", description: pairings?.length ? "Choose New project to set up an SDK project, or approve the device waiting in Devices." : "Choose New project to create a project with the SDK and connect it here." },
      section: { label: "", count: "" }, pinned: devicesNode(pairings?.length ?? 0) },
    main: { crumb: [{ label: "Getting started" }], meta: "", actions: [{ name: "new-project", label: "New project", variant: "primary" }], body: { kind: "empty", text: "Bring your own simulator: create a project with the SDK, connect it to this workbench, and its investigations appear here. Choose New project to begin." }, credit: "" },
    details: { icon: "device", title: "Devices", status: { text: pairings?.length ? "Connection approval needed" : "Connect your SDK" },
      sections: [...(notice ? [{ heading: "Not saved", blocks: [{ kind: "text" as const, text: notice, tone: "danger" as const }] }] : []), ...(dev ? [dev.section] : [])], actions: dev?.actions },
  };
}

export function loading(_source: string): View {
  const description = "Reading projects and investigations from the daemon. This may take a moment.";
  return {
    sidebar: { switcher: { kind: "loading", label: "Project", value: "", options: [] },
      pinned: devicesNode(0),
      notice: { kind: "loading", title: "Connecting to autophys", description: "Loading your workspace…" },
      section: { label: "", count: "" }, nodes: [], treeLabel: "Investigations", selectedId: null, expandedIds: [] },
    main: { crumb: [{ label: "Workspace" }], meta: "", actions: [], body: { kind: "loading", title: "Connecting to autophys", description }, credit: "" },
    details: { icon: "workspace", title: "Workspace", status: { text: "Connecting" }, sections: [{ heading: "Your records", blocks: [{ kind: "text", text: "Project configuration and device requests will appear when the connection is ready." }] }] },
  };
}

export function connectionFailure(view: View, error: string, loaded: boolean): View {
  return { ...view,
    sidebar: loaded ? view.sidebar : { ...view.sidebar, switcher: { ...view.sidebar.switcher, kind: "unavailable" }, notice: undefined },
    main: { ...view.main, connectionError: `${error.replace(/[.!?]$/, "")}. ${loaded ? "Showing stale records until the daemon reconnects." : "Check that your daemon is running, then retry the connection."} Approvals are paused.`,
      ...(loaded ? {} : { body: { kind: "unavailable", title: "Your workspace", description: "Projects and investigations will appear here once records are loaded." } }) },
    details: loaded ? view.details : { ...view.details, status: { text: "No records loaded" }, sections: [] },
  };
}

export function derive(snapshot: Snapshot | null, selection: Selection, source = "the source"): View {
  if (!snapshot) return loading(source);
  let view: View;
  if (!snapshot.workspace.projects.length) view = empty(snapshot.source, snapshot.pairings, selection.notice);
  else {
    const s = { ...selection, ws: snapshot.workspace, events: snapshot.events, pairings: snapshot.pairings };
    const project = snapshot.workspace.projects.find((p) => p.id === selection.projectId) ?? snapshot.workspace.projects[0];
    if (!project.configs.length) {
      const dev = devices(s);
      view = { sidebar: sidebarModel(s),
        main: { crumb: [{ label: project.name }], meta: "", actions: [], body: onboarding(project.name), credit: "" },
        details: { icon: "config", title: "Project configuration", status: { text: "Awaiting first investigation" },
          sections: [{ heading: "", blocks: [{ kind: "missing", title: "Record your configuration", description: "This project is registered. Start its first investigation from the Python SDK to record the simulator configuration." }] }, ...(dev ? [dev.section] : [])], actions: dev?.actions },
      };
    } else view = { sidebar: sidebarModel(s), main: mainModel(s), details: detailsModel(s) };
    if (!project.investigations.length && view.main.body.kind !== "configuration") {
      view.main = { ...view.main, crumb: [{ label: project.name }], meta: "", body: onboarding(project.name) };
    }
  }
  if (view.main.body.kind === "onboarding") view.main.body.copyLabel = selection.copyStatus === "copied" ? "Copied Python" : selection.copyStatus === "select" ? "Code selected · copy" : "Copy Python";
  return view;
}

export { ancestors, defaultExpanded, defaultSelection, draftKey, ids, parseSel, type Selection, type State } from "./shared.ts";
export { covers, displayedFields, interpolate, outlookAt } from "./outlook.ts";
export { viewsOf } from "./charts.ts";
