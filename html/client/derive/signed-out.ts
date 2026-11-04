/**
 * `serve --login`, signed out: the app makes no API calls and its panes ask to sign in. The
 * main pane holds the only message (Sign in, or the read-only recorded demo); the sidebar and
 * details keep their shape with placeholders and repeat nothing.
 */
import type { View } from "./index.ts";

export const SIGN_IN_TITLE = "Sign in to Autophys";
export const SIGN_IN_DESCRIPTION = "Use the email you were invited with.";

export function signedOutView(view: View, demo = false): View {
  return {
    sidebar: { ...view.sidebar, switcher: { ...view.sidebar.switcher, kind: "loading" },
      notice: { kind: "loading", title: "", description: "" }, nodes: [], selectedId: null, expandedIds: [] },
    main: { crumb: [{ label: "Workspace" }], meta: "", actions: [],
      body: { kind: "signed-out", title: SIGN_IN_TITLE, description: SIGN_IN_DESCRIPTION, demo }, credit: "" },
    details: { icon: "workspace", title: "Workspace", status: { text: "" }, sections: [], placeholder: true },
  };
}

/**
 * The workspace is loading: placeholders in every pane and no text (design A). The panes keep
 * their shape, so the hand-off from the sign-in card (or a fresh load) to data does not flash
 * three "Connecting" messages first. The main pane keeps an
 * announced (not drawn) "Loading your workspace" for screen readers.
 */
export function quietLoading(view: View): View {
  if (view.main.body.kind !== "loading") return view;
  return {
    sidebar: { ...view.sidebar, notice: { kind: "loading", title: "", description: "" } },
    main: { ...view.main, crumb: [{ label: "Workspace" }], body: { kind: "loading", title: "Loading your workspace", description: "" } },
    details: { icon: "workspace", title: "Workspace", status: { text: "" }, sections: [], placeholder: true },
  };
}
