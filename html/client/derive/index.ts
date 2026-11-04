/** Snapshot + selection → the three view-only surfaces, including explicit null states. */
import type { Snapshot } from "../api.ts";
import type { Pairing } from "../domain.ts";
import type { DetailsModel, MainModel, SidebarModel } from "../../ui/view-model.ts";
import { detailsModel, devices } from "./details.ts";
import { mainModel } from "./main.ts";
import { onboarding } from "./onboarding.ts";
import type { Selection } from "./shared.ts";
import { sidebarModel } from "./tree.ts";

export type View = { sidebar: SidebarModel; main: MainModel; details: DetailsModel };

export function empty(source: string, pairings?: Pairing[], notice?: string): View {
  const base = loading(source), dev = devices({ pairings: pairings ?? [] });
  return {
    sidebar: { ...base.sidebar, switcher: { ...base.sidebar.switcher, kind: "none" },
      notice: { kind: "no-projects", title: "No projects yet", description: "A project is one simulator and its declared configuration." },
      section: { label: "", count: "" }, pinned: { id: "devices", label: "Devices", icon: "config", selectable: true, children: null,
        trail: pairings?.length ? { badge: `${pairings.length} pending` } : { text: "Pair SDK" } } },
    main: { crumb: [{ label: "Getting started" }], meta: "", actions: [], body: onboarding(), credit: "" },
    details: { icon: "device", title: "Devices", status: { text: pairings?.length ? "Connection approval needed" : "Connect your SDK" },
      sections: [...(notice ? [{ heading: "Not saved", blocks: [{ kind: "text" as const, text: notice, tone: "danger" as const }] }] : []), ...(dev ? [dev.section] : [])], actions: dev?.actions },
  };
}

export function loading(_source: string): View {
  const description = "Reading projects and investigations from the daemon. This may take a moment.";
  return {
    sidebar: { switcher: { kind: "loading", label: "Project", value: "", options: [] },
      pinned: { id: "loading", label: "Connecting", icon: "config", selectable: false, children: null, dim: true },
      notice: { kind: "loading", title: "Connecting to autophys", description: "Loading your workspace…" },
      section: { label: "", count: "" }, nodes: [], treeLabel: "Investigations", selectedId: null, expandedIds: [] },
    main: { crumb: [{ label: "Workspace" }], meta: "", actions: [], body: { kind: "loading", title: "Connecting to autophys", description }, credit: "" },
    details: { icon: "workspace", title: "Workspace", status: { text: "Connecting" }, sections: [{ heading: "Your records", blocks: [{ kind: "text", text: "Project configuration and device requests will appear when the connection is ready." }] }] },
  };
}

export function connectionFailure(view: View, error: string, loaded: boolean): View {
  const description = "Check that your daemon is running and open its URL to renew your session. Retry the connection or explore the demo.";
  return { ...view,
    sidebar: loaded ? view.sidebar : { ...view.sidebar, switcher: { ...view.sidebar.switcher, kind: "unavailable" },
      notice: { kind: "unavailable", title: "Connection unavailable", description: "Retry from the workspace to load your projects." } },
    main: { ...view.main, connectionError: loaded ? `${error} Last loaded records are shown until you reconnect.` : error, ...(loaded ? {} : { body: { kind: "unavailable", title: "Unable to connect", description } }) },
    details: { ...view.details, status: loaded ? view.details.status : { text: "Connection unavailable" }, sections: [{ heading: "Connection error", blocks: [{ kind: "text", text: error, tone: "danger" }] }, ...view.details.sections] },
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
  view.main.source = snapshot.source === "fixture" ? "demo" : "live";
  return view;
}

export { ancestors, defaultExpanded, defaultSelection, draftKey, ids, parseSel, type Selection, type State } from "./shared.ts";
export { covers, displayedFields, interpolate, outlookAt } from "./outlook.ts";
export { viewsOf } from "./charts.ts";
