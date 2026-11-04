/**
 * What the components report: the raw DOM intent, never its meaning. A click on a row or a
 * crumb names the node id; a button names its action; a field reports its name and the raw
 * text typed; the switcher reports the chosen value. The caller decides what any of it does.
 */
export type Intent =
  | { kind: "select"; id: string }
  | { kind: "toggle"; id: string; open: boolean }
  | { kind: "switch"; value: string }
  | { kind: "action"; name: string }
  /** `commit` is false while typing (input) and true when the field is left or Enter is pressed (change). */
  | { kind: "field"; name: string; raw: string; commit: boolean };

export type IntentHandler = (intent: Intent) => void;

/** The attribute every interactive element carries, and its companions. */
export const ATTR = { role: "data-ap", id: "data-ap-id", name: "data-ap-name" } as const;

/** The part of an element the decoder reads: works on a real element or a test stand-in. */
export type IntentSource = {
  getAttribute(name: string): string | null;
  value?: string;
  disabled?: boolean;
};

/** The intent an element stands for on a click (`event` "click") or an edit ("input" / "change"). */
export function intentOf(el: IntentSource, event: "click" | "input" | "change"): Intent | null {
  if (el.disabled) return null;
  const role = el.getAttribute(ATTR.role);
  if (event === "click") {
    if (role === "select") {
      const id = el.getAttribute(ATTR.id);
      return id ? { kind: "select", id } : null;
    }
    if (role === "action") {
      const name = el.getAttribute(ATTR.name);
      return name ? { kind: "action", name } : null;
    }
    return null;
  }
  if (role === "field") {
    const name = el.getAttribute(ATTR.name);
    return name ? { kind: "field", name, raw: String(el.value ?? ""), commit: event === "change" } : null;
  }
  if (role === "switch" && event === "change") return { kind: "switch", value: String(el.value ?? "") };
  return null;
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
