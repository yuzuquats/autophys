import { RailNav } from "../components/rail/rail-nav";

export type AdminNavHandle = {
  updateSelection(path: string): void;
};

/** The admin routes, in rail order. The dashboard answers to a trailing slash
 * as well; `canonical` is the one key both spellings select. */
const ROUTES: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/_/admin" },
  { label: "Logs", path: "/_/admin/logs" },
  { label: "Routes", path: "/_/admin/routes" },
  { label: "UX Tests", path: "/_/admin/ux-tests" },
];

function canonical(path: string): string {
  return path === "/_/admin/" ? "/_/admin" : path;
}

export function buildAdminNav(
  $nav: HTMLElement,
  onNavigate: (path: string) => void,
): AdminNavHandle {
  // One untitled section: the admin board has four routes and no grouping, so
  // the nav is the route table and nothing else.
  const $rail = RailNav.makeWith({
    sections: [{
      rows: ROUTES.map((route) => ({ key: route.path, label: route.label })),
    }],
    onSelect: onNavigate,
  });
  $nav.appendChild($rail);

  const updateSelection = (path: string): void => {
    $rail.select(canonical(path));
  };

  updateSelection(window.location.pathname);

  return { updateSelection };
}
