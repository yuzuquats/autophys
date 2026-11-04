// The tier-1 charter's category vocabulary — hand-written, DOM-free, importable
// by the deno scripts that check the allowlist and by the browser bundle that
// renders the catalogue. The categories are the Astryx design system's,
// verbatim, because the operator wants the library to read like other
// libraries; that is the only thing borrowed. Each component is reviewed on
// our own contract, not on parity.
//
// A category is the second column of `std-charter.allowlist`. It lives there
// rather than on the story so a card can only appear in a section a reviewer
// admitted it to — admission and placement are one diff line.

export namespace StdCharter {
  export type Category =
    | "action"
    | "chat"
    | "container"
    | "content"
    | "feedback-status"
    | "form-controls"
    | "layout"
    | "navigation"
    | "overlay"
    | "table-list"
    | "utility";

  /** Display order and labels, verbatim from the Astryx catalogue. */
  export const CATEGORIES: readonly { id: Category; label: string }[] = [
    { id: "action", label: "Action" },
    { id: "chat", label: "Chat" },
    { id: "container", label: "Container" },
    { id: "content", label: "Content" },
    { id: "feedback-status", label: "Feedback & Status" },
    { id: "form-controls", label: "Form Controls" },
    { id: "layout", label: "Layout" },
    { id: "navigation", label: "Navigation" },
    { id: "overlay", label: "Overlay" },
    { id: "table-list", label: "Table & List" },
    { id: "utility", label: "Utility" },
  ];

  const IDS: ReadonlySet<string> = new Set(CATEGORIES.map((c) => c.id));

  export function isCategory(s: string): s is Category {
    return IDS.has(s);
  }

  export function label(category: Category): string {
    return CATEGORIES.find((c) => c.id === category)!.label;
  }
}
