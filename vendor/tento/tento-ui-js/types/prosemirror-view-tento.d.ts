// tento's fork of prosemirror-view (tento-plugins-js/prosemirror-view) is what
// the bundle ships; consumers keep their types on the upstream package and
// take the fork's added surface from here. Keep in step with the fork's
// src/index.ts.
import "prosemirror-view";

declare module "prosemirror-view" {
  interface EditorView {
    /** Rendered, not listening: no mutation observer, no selection listener, no input handlers, not editable. */
    dormant: boolean;
    /** Wake a dormant view, or put a live one to sleep; re-renders the document decorations so `contenteditable` follows. */
    setDormant(dormant: boolean): void;
  }
  interface DirectEditorProps {
    /** Create the view dormant; `setDormant(false)` or `focus()` wakes it. */
    dormant?: boolean;
  }
}
