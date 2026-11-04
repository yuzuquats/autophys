/**
 * derive: a snapshot and the controller's selection in, the three view models out. Their
 * types are the ui's own (SidebarModel, MainModel, DetailsModel), so the compiler checks the
 * seam between data and drawing.
 */
import type { Snapshot } from "../api.ts";
import type { DetailsModel, MainModel, SidebarModel } from "../../ui/view-model.ts";
import { detailsModel } from "./details.ts";
import { mainModel } from "./main.ts";
import type { Selection } from "./shared.ts";
import { sidebarModel } from "./tree.ts";

export type View = { sidebar: SidebarModel; main: MainModel; details: DetailsModel };

/** What the surfaces show before the source has answered. */
export function loading(source: string): View {
  return {
    sidebar: { switcher: { label: "Project", value: "", options: [] }, pinned: { id: "loading", label: "Configuration", icon: "config", selectable: false, children: null, dim: true },
      section: { label: "Investigations", count: "…" }, nodes: [], treeLabel: "Investigations", selectedId: null, expandedIds: [] },
    main: { crumb: [{ label: "Loading" }], meta: source, actions: [], body: { kind: "empty", text: `Loading from ${source}` }, credit: "" },
    details: { icon: "workspace", title: "Details", status: { text: "Loading" }, sections: [] },
  };
}

export function derive(snapshot: Snapshot | null, selection: Selection): View {
  if (!snapshot) return loading("the source");
  const s = { ...selection, ws: snapshot.workspace };
  return { sidebar: sidebarModel(s), main: mainModel(s), details: detailsModel(s) };
}

export { ancestors, defaultExpanded, defaultSelection, draftKey, ids, parseSel, type Selection, type State } from "./shared.ts";
export { covers, displayedFields, interpolate, outlookAt } from "./outlook.ts";
export { viewsOf } from "./charts.ts";
