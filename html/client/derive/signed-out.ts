/**
 * `serve --login`, signed out: the app makes no API calls and its panes ask to sign in. The
 * main pane holds the only message (Sign in, or the read-only recorded demo); the sidebar and
 * details keep their shape with placeholders and repeat nothing.
 */
import type { View } from "./index.ts";

export const SIGN_IN_TITLE = "Sign in to open the workbench";
export const SIGN_IN_DESCRIPTION =
  "Your projects and investigations belong to your account. Without one, you can look around the recorded demo.";

export function signedOutView(view: View): View {
  return {
    sidebar: { ...view.sidebar, switcher: { ...view.sidebar.switcher, kind: "loading" },
      notice: { kind: "loading", title: "", description: "" }, nodes: [], selectedId: null, expandedIds: [] },
    main: { crumb: [{ label: "Workspace" }], meta: "", actions: [],
      body: { kind: "signed-out", title: SIGN_IN_TITLE, description: SIGN_IN_DESCRIPTION }, credit: "" },
    details: { icon: "workspace", title: "Workspace", status: { text: "" }, sections: [] },
  };
}
