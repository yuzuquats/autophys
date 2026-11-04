// How anything inside a settings surface asks for a sub-page without holding
// the page: it dispatches this composed event, and whatever page frame the
// consumer composed around its sections listens for it (across shadow
// roots), cancels it and pushes the destination. The library has no page of
// its own — a modal with a stack, a single document and a sidebar all frame
// sections differently. A row with `page`, a button in a custom section and a
// link in a pushed page all use it, so sections compose without threading a
// page reference through every bind.
//
// The destination is resolved by the listener (`SettingsSchema.resolve`), so
// it can be a schema, an element or a factory that builds either only when
// the page is actually opened.
export namespace SettingsNavigate {
  export const EVENT = "std-settings-navigate";

  export type Destination<Content> = {
    title: string;
    caption?: Option<string>;
    content: Content | (() => Content);
  };

  export function dispatch<Content>($from: Element, destination: Destination<Content>): boolean {
    const event = new CustomEvent<Destination<Content>>(EVENT, {
      detail: destination,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    // A page that handles it cancels it; false means no page was above $from.
    return !$from.dispatchEvent(event);
  }
}
