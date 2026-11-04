import { Tracing } from "@tento-core/tracing";

export type RouteNode = {
  handler?: Option<(components: string[]) => void>;
  children: Map<string, RouteNode>;
  wildcardChild?: RouteNode;
};

export namespace Router {
  export const BASE_URL = new URL(document.location.toString()).origin;

  // TODO: use evt?
  // TODO: assuming BASE_URL seems super sussy
  window.addEventListener("load", router);
  window.addEventListener("hashchange", router);
  window.addEventListener("popstate", router);
  function router(e: Event) {
    // e.preventDefault();
    // An app that registered no routes is not a routing app. The listeners above
    // are installed when this module is *imported*, so a page that merely pulls
    // Router in for a runtime `navigateTo` would otherwise dispatch on load,
    // find an empty trie, and log a spurious error on every boot.
    if (root.children.size === 0 && root.wildcardChild == null) return;
    Tracing.info("nav")("route callback", e);
    Router.navigateTo(
      new URL(window.location.toString()),
      // Native load/hash/history events already have their history entry.
      // Pushing here duplicates Back destinations and discards Forward entries.
      false,
    );
  }

  const root: RouteNode = {
    handler: null,
    children: new Map(),
  };

  const navigateListeners = new Set<(pathname: string) => void>();

  // Subscribe to SPA navigations; the listener fires after each navigateTo
  // resolves its route. Used by persistent chrome — e.g. the landing nav's
  // current-page highlight — that outlives individual pagelets and must
  // re-derive its state from the new URL. Returns an unsubscribe function.
  export function onNavigate(listener: (pathname: string) => void): () => void {
    navigateListeners.add(listener);
    return () => navigateListeners.delete(listener);
  }

  function decodePathParameter(component: string): string {
    try {
      return decodeURIComponent(component);
    } catch {
      return component;
    }
  }

  export function addRoute(
    path: string,
    handler: (components: string[]) => void,
  ) {
    const components = path
      .toLocaleLowerCase()
      .split("/")
      .filter((value) => value.length > 0);
    let parent = root;
    for (const component of components) {
      if (component.startsWith("{") && component.endsWith("}")) {
        let node = parent.wildcardChild;
        if (!node) {
          node = {
            handler: null,
            children: new Map(),
          };
          parent.wildcardChild = node;
        }
        parent = node;
        continue;
      }

      let node = parent.children.get(component);
      if (!node) {
        node = {
          handler: null,
          children: new Map(),
        };
        parent.children.set(component, node);
      }
      parent = node;
    }
    if (parent.handler != null) {
      Tracing.err("nav")("handler for parent already set!", path);
    }
    parent.handler = handler;
  }

  export function navigateTo(url: URL | string, pushState: boolean = true) {
    if (typeof url === "string") {
      url = new URL(url, BASE_URL);
    }

    if (pushState) history.pushState({}, "", url);

    const components = url.pathname
      .toLocaleLowerCase()
      .split("/")
      .filter((value) => value.length > 0);
    const pathParameters: string[] = [];
    let currNode = root;
    for (const component of components) {
      const node = currNode.children.get(component);
      if (node) {
        currNode = node;
        continue;
      }
      if (currNode.wildcardChild != null) {
        pathParameters.push(decodePathParameter(component));
        currNode = currNode.wildcardChild;
        continue;
      }
      break;
    }
    if (currNode.handler) {
      currNode.handler(pathParameters);
    } else {
      // todo: just redirect normally
      Tracing.err("nav")(`no handler for route ${url.pathname}`);
    }
    for (const listener of navigateListeners) listener(url.pathname);
  }

  // The leading path segment of a URL path, lowercased — the "section" a page
  // belongs to (e.g. "/features/calendar" → "features"). Empty for "/" or "".
  // Pure; mirrors the tokenization used by addRoute/navigateTo above.
  export function sectionOf(pathname: string): string {
    return pathname
      .toLocaleLowerCase()
      .split("/")
      .filter((value) => value.length > 0)[0] ?? "";
  }
}
