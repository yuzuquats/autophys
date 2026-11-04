// The renderer seam for review-note graph diagrams. Flow/state build a
// renderer-agnostic spec — DOM node elements plus edges and a preferred
// direction — and hand it to whichever engine is active. The CSS-grid
// renderer (GraphGrid) is the default; alternative engines (physics-based,
// an actual mermaid pipeline, …) implement Renderer and swap in via `use()`
// without the diagram components changing.

import type { Style } from "../../component-styles";

export namespace GraphRenderer {
  export type Node = { id: string; $el: HTMLElement };
  export type Edge = {
    from: string;
    to: string;
    label: Option<string>;
    /** Extra class on the wire (e.g. "dashed", "tr-new"). */
    cls: Option<string>;
  };
  export type Spec = {
    nodes: Node[];
    edges: Edge[];
    /** Preferred flow direction; a renderer may override it to fit the
     * container (narrow column → taller-than-wide). */
    dir: "LR" | "TD";
    /** How the caller's own diagram vocabulary looks: the node boxes it
     * built, and the wire/label classes it named in `Edge.cls`. An engine
     * that renders into its own shadow root puts them out of reach of the
     * caller's stylesheet, so the caller hands that stylesheet over with the
     * spec rather than losing it. Null for a caller that styles nothing. */
    theme: Option<Style.Compat>;
  };

  export interface Renderer {
    $render(spec: Spec): HTMLElement;
  }

  let active: Option<Renderer> = null;

  /** Swap the drawing engine for every diagram rendered after this call. */
  export function use(renderer: Renderer): void {
    active = renderer;
  }

  /** The engine `use()` installed, if any; callers fall back to a default. */
  export function current(): Option<Renderer> {
    return active;
  }
}
