/**
 * The two addresses the client owns, so Back and Forward retrace the drawer:
 *
 *   /              the landing: the pitch deck, app closed
 *   /app/<item>    the app open on one workspace item (/app opens the first)
 *
 * The server answers both with index.html (server/src/lib.rs).
 */
export type Route = { readonly app: false } | { readonly app: true; readonly item: string | null };

const appPath = /^\/app(?:\/([^/]+))?\/?$/;

export function readRoute(pathname: string): Route {
  const match = pathname.match(appPath);
  if (!match) return { app: false };
  return { app: true, item: match[1] === undefined ? null : decode(match[1]) };
}

export function routeUrl(route: Route): string {
  return route.app && route.item ? `/app/${encodeURIComponent(route.item)}` : route.app ? "/app" : "/";
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}
