/**
 * The two addresses a cookbook app owns, so Back and Forward retrace the drawer:
 *
 *   /                the landing: the pitch deck, app closed
 *   <base>/<item>    the app open on one item (<base> alone opens the default)
 *
 * <base> defaults to /app. The app's server must answer both with its
 * index.html.
 */
export type Route = { readonly app: false } | { readonly app: true; readonly item: string | null };

export function readRoute(pathname: string, base = "/app"): Route {
  if (pathname === base || pathname === `${base}/`) return { app: true, item: null };
  if (!pathname.startsWith(`${base}/`)) return { app: false };
  const rest = pathname.slice(base.length + 1).replace(/\/$/, "");
  if (!rest || rest.includes("/")) return { app: false };
  return { app: true, item: decode(rest) };
}

export function routeUrl(route: Route, base = "/app"): string {
  if (!route.app) return "/";
  return route.item ? `${base}/${encodeURIComponent(route.item)}` : base;
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}
