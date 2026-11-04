import "../../admin/admin-page-layout";
import "../commit-review/review-rail";
import "../docs-nav/docs-nav";
import "../list/list";
import "../shell-layout/shell-layout";
import "../sidebar/sidebar-expand-button";

import { buildAdminNav } from "../../admin/admin-nav";
import { AdminPageLayout } from "../../admin/admin-page-layout";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { ReviewRail } from "../commit-review/review-rail";
import { DocsNav } from "../docs-nav/docs-nav";
import { List } from "../list/list";
import { ListCellLayout } from "../list/list-cell-layout";
import { ShellLayout } from "../shell-layout/shell-layout";
import { SidebarExpandButton } from "../sidebar/sidebar-expand-button";

// The survey figure for `sidebar(1)-kit`: the sidebars the plan proposes to
// unify, each rebuilt here from the primitives it ALREADY stands on, at the
// width it ships at, side by side. Nothing in this file is new UI — every
// card composes checkout code the way its surface does, so what the reader
// compares is the surfaces, not a mock of them.
//
// What each card is for:
//
//   /dev ............ std-shell-layout + std-docs-nav, one library, every
//                     section forced open (`defaultExpanded`). In the app the
//                     shell is a hand-rolled partial (dev-shell.html) that
//                     re-implements this component's [docked] rule; the card
//                     shows the partial was never needed.
//   /docs ........... the same two components with three libraries and the
//                     avatar resolver — the shape /dev/docs, admin /docs and
//                     admin /projects all share.
//   ux-tests admin .. std-admin-page-layout + buildAdminNav: a sidebar-
//                     container bound once, never collapsed, a 4-row list
//                     under an <h1>.
//   brand-acme ...... std-shell-layout with the theme rail reproduced inline
//                     from refs/scratch/yuzu-master (acme-sidebar.ts is in no
//                     worktree): a heading, a List with the -8px margin, and a
//                     selection map — the same three things docs-nav carries.
//   review rail ..... review-rail, the frame the plan extracts `std-rail`
//                     from: owned width, resizer, collapse, persisted.
//
// Two cards this file cannot carry, and says so: the ux-tests console rail
// lives only in a tento draft (44cc0ef9) and acme's real component only on a
// scratch ref. Neither imports from a checkout, so neither renders here.
//
// The shell's mobile breakpoint is pinned to 0 in every card: inside the
// review harness `window.innerWidth` is the card frame, which is often under
// the 768px default, and a shell that flips to its modal drawer would be
// showing the reader a phone layout of a desktop sidebar.

const CARD_HEIGHT_PX = 420;

/** The fixed-height box every card lays out in, standing in for the page. */
function $frame(): HTMLElement {
  const $box = document.createElement("div");
  $box.style.display = "flex";
  $box.style.height = `${CARD_HEIGHT_PX}px`;
  $box.style.border = "1px solid var(--divider)";
  $box.style.borderRadius = "8px";
  $box.style.overflow = "hidden";
  $box.style.background = "var(--bg)";
  return $box;
}

/** Stand-in for the page a shell frames: a labelled, empty content pane. */
function $pane(label: string): HTMLElement {
  const $p = document.createElement("div");
  $p.style.flex = "1";
  $p.style.minWidth = "0";
  $p.style.padding = "16px";
  $p.style.font = "12px system-ui, sans-serif";
  $p.style.color = "var(--text-ter)";
  $p.textContent = label;
  return $p;
}

/** A shell at a real surface width, its expand button in the header slot.
 * The breakpoint is 0 (see the file comment) and the sidebar-container's
 * top/height are pinned to the box rather than the viewport. */
function $shell(sidebarWidthPx: number, headerLabel: string): {
  $layout: ShellLayout;
  $header: HTMLElement;
} {
  const $layout = ShellLayout.make();
  $layout.style.height = "100%";
  $layout.style.flex = "1";
  $layout.style.minWidth = "0";
  $layout.style.setProperty("--sidebar-container-top", "0px");
  $layout.style.setProperty("--sidebar-container-height", "100%");

  const $header = document.createElement("div");
  $header.slot = "header";
  $header.style.display = "flex";
  $header.style.alignItems = "center";
  $header.style.gap = "8px";
  $header.style.padding = "6px 12px";
  $header.style.borderBottom = "1px solid var(--divider)";
  $header.style.font = "600 13px system-ui, sans-serif";
  $header.style.color = "var(--text-pri)";

  const $expand = SidebarExpandButton.make();
  const $title = document.createElement("span");
  $title.textContent = headerLabel;
  $header.append($expand, $title);
  $layout.appendChild($header);

  $layout.bind({
    geometry: {
      sidebarWidthPx,
      mobileBreakpointPx: 0,
      mobileSidebarMarginPx: 24,
    },
    expandButton: $expand,
    initialSidebarCollapsed: false,
    onSidebarCollapsedChange: null,
  });
  return { $layout, $header };
}

/** /dev's nav, as dev-boot.ts builds it: one library, six sections. */
const DEV_LIBRARY: DocsNav.NavLibrary = {
  title: "Dev",
  namespace: "dev",
  path: "/dev",
  sections: [
    { title: "GTM", children: [
      { label: "Campaigns", path: "/dev/campaigns", slug: "campaigns" },
      { label: "Landing", path: "/dev/landing", slug: "landing" },
      { label: "Features", path: "/dev/features", slug: "features" },
    ] },
    { title: "Screenshots", children: [
      { label: "Specs", path: "/dev/screenshots", slug: "screenshots" },
    ] },
    { title: "Assets", children: [
      { label: "Studio", path: "/dev/assets", slug: "assets" },
      { label: "Stickers", path: "/dev/assets/stickers", slug: "stickers" },
      { label: "Chat", path: "/dev/assets/chat", slug: "chat" },
    ] },
    { title: "Publishing", children: [
      { label: "Releases", path: "/dev/releases", slug: "releases" },
      { label: "Changelog", path: "/dev/changelog", slug: "changelog" },
    ] },
    { title: "Reference", children: [
      { label: "Docs", path: "/dev/docs", slug: "docs" },
      { label: "Storybook", path: "/dev/ui", slug: "ui" },
      { label: "Projects", path: "/dev/projects", slug: "projects" },
    ] },
    { title: "Todo", children: [
      { label: "Board", path: "/dev/todo", slug: "todo" },
    ] },
  ],
};

/** /docs's nav: three libraries of the three kinds the avatar resolver
 * colours (a JS package, a lona surface, a Rust crate). */
const DOCS_LIBRARIES: DocsNav.NavLibrary[] = [
  {
    title: "@tento-ui",
    namespace: "tento-ui-js",
    path: "/docs/tento-ui-js",
    sections: [
      { title: "Components", children: [
        { label: "Accordion", path: "/docs/tento-ui-js/accordion", slug: "accordion" },
        { label: "List", path: "/docs/tento-ui-js/list", slug: "list" },
        { label: "Sidebar container", path: "/docs/tento-ui-js/sidebar", slug: "sidebar" },
      ] },
      { title: "Layout", children: [
        { label: "Shell layout", path: "/docs/tento-ui-js/shell", slug: "shell" },
        { label: "Docs nav", path: "/docs/tento-ui-js/docs-nav", slug: "docs-nav" },
      ] },
    ],
  },
  {
    title: "lona-console",
    namespace: "lona-console",
    path: "/docs/lona-console",
    sections: [
      { title: "", children: [
        { label: "Commands", path: "/docs/lona-console/commands", slug: "commands" },
        { label: "Fleet", path: "/docs/lona-console/fleet", slug: "fleet" },
      ] },
    ],
  },
  {
    title: "tento-chrono",
    namespace: "tento-chrono",
    path: "/docs/tento-chrono",
    sections: [
      { title: "Types", children: [
        { label: "NaiveDate", path: "/docs/tento-chrono/naive-date", slug: "naive-date" },
        { label: "Recurrence", path: "/docs/tento-chrono/recurrence", slug: "recurrence" },
      ] },
    ],
  },
];

function $docsNavCard(args: {
  widthPx: number;
  header: string;
  libraries: DocsNav.NavLibrary[];
  activePath: string;
  defaultExpanded: boolean;
  paneLabel: string;
}): HTMLElement {
  const $box = $frame();
  const { $layout } = $shell(args.widthPx, args.header);

  const $nav = DocsNav.make();
  $nav.slot = "sidebar";
  $nav.bind({
    items: args.libraries,
    activePath: args.activePath,
    onNavigate: (path) => $nav.setActivePath(path),
    iconForLibrary: DocsNav.LibraryIcons.docs,
    defaultExpanded: args.defaultExpanded,
  });

  const $content = $pane(args.paneLabel);
  $content.slot = "content";

  $layout.append($nav, $content);
  $box.appendChild($layout);
  return $box;
}

/** The ux-tests admin board's frame, exactly as std-admin-page-layout binds
 * it: 240px, docked once in connectedCallback, no expand affordance. */
function $adminCard(): HTMLElement {
  const $box = $frame();
  const $admin = AdminPageLayout.make();
  // The layout sizes itself to the viewport (`:host { height: 100vh }`); the
  // card pins it to the box instead.
  $admin.style.height = "100%";
  $admin.style.flex = "1";
  $admin.style.minWidth = "0";
  const nav = buildAdminNav($admin.$navContainer, (path) =>
    nav.updateSelection(path),
  );
  nav.updateSelection("/_/admin/ux-tests");
  $admin.$main.appendChild(
    $pane("the sessions table — 240px fixed, never collapses, --sidebar-stickied-width goes stale on a docked↔peek toggle"),
  );
  $box.appendChild($admin);
  return $box;
}

/** brand-acme's theme rail, reproduced from acme-chrome.ts / acme-sidebar.ts
 * on refs/scratch/yuzu-master: a 0.65rem uppercase heading, a List whose
 * rows carry the -8px margin, and a selection map over kept cell refs. */
function $acmeCard(): HTMLElement {
  const $box = $frame();
  const { $layout } = $shell(300, "acme.site");

  const $sidebar = document.createElement("div");
  $sidebar.slot = "sidebar";
  $sidebar.style.display = "flex";
  $sidebar.style.flexDirection = "column";
  $sidebar.style.minHeight = "100%";
  $sidebar.style.font = "15px/1.5 -apple-system, system-ui, sans-serif";

  const $heading = document.createElement("div");
  $heading.textContent = "Themes";
  $heading.style.color = "var(--text-ter)";
  $heading.style.fontSize = "0.65rem";
  $heading.style.letterSpacing = "0.14em";
  $heading.style.textTransform = "uppercase";
  $heading.style.padding = "4px 8px 8px 0px";

  const themes = ["starter", "contrast", "pi", "ledger", "port"];
  const refs = new Map<string, { $cell: Option<ListCellLayout> }>();
  let active = "pi";
  const updateSelection = (): void => {
    for (const [theme, ref] of refs) {
      ref.$cell?.toggleAttribute("selected", theme === active);
    }
  };
  let builder = List.builder();
  for (const theme of themes) {
    const ref: { $cell: Option<ListCellLayout> } = { $cell: null };
    refs.set(theme, ref);
    builder = builder.row(theme, {
      ref,
      pointerEvents: {
        onClick: (_$el, _offset, e) => {
          e.preventDefault();
          active = theme;
          updateSelection();
        },
      },
    });
  }
  const $rows = builder.build();
  $rows.style.margin = "0px 0px 0px -8px";

  const $footer = Typography.p(
    "Each row renders the page you are on through another template.",
  );
  $footer.style.marginTop = "auto";
  $footer.style.paddingTop = "12px";
  $footer.style.color = "var(--text-ter)";
  $footer.style.fontSize = "0.7rem";

  $sidebar.append($heading, $rows, $footer);
  updateSelection();

  const $content = $pane("the site, drawn from --brand-* tokens; the rail is firewalled to @tento-ui tokens");
  $content.slot = "content";

  $layout.append($sidebar, $content);
  $box.appendChild($layout);
  return $box;
}

/** The commit-review rail in its own layout: a flex row it owns the width of.
 * The one sidebar here with a resizer, a collapse and a persisted width. */
function $reviewRailCard(): HTMLElement {
  const $box = $frame();
  const $rail = ReviewRail.make();
  const $rows = document.createElement("div");
  $rows.style.padding = "10px 12px";
  $rows.style.font = "12.5px/1.6 system-ui, sans-serif";
  $rows.style.color = "var(--text-sec)";
  $rows.style.whiteSpace = "nowrap";
  for (let i = 0; i < 16; i += 1) {
    const $row = document.createElement("div");
    $row.textContent = `draft ${i + 1} — a subject long enough to clip`;
    $rows.appendChild($row);
  }
  $rail.appendChild($rows);
  $rail.setCollapsed(false, false);
  $rail.setView("stack", false);
  $box.append($rail, $pane("the diff pane — drag the rail's edge; double-click resets"));
  return $box;
}

export class RailSurveyStoryBook extends Storybook.Default {
  title(): string {
    return "Rail survey — the sidebars sidebar(1)-kit unifies";
  }

  description(): Option<string> {
    return (
      "Each card is a surface rebuilt from the primitives it already uses, at " +
      "its shipping width. Not shown: the ux-tests console rail (tento draft " +
      "44cc0ef9 only) and acme's real component (scratch ref only)."
    );
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "/dev — std-shell-layout + std-docs-nav, 280px, every section open",
        render: () =>
          $docsNavCard({
            widthPx: 280,
            header: "Lona Dev",
            libraries: [DEV_LIBRARY],
            activePath: "/dev/assets",
            defaultExpanded: true,
            paneLabel: "the pagelet mounted for the selected route",
          }),
      },
      {
        title: "/docs — the same two components, three libraries, 340px",
        render: () =>
          $docsNavCard({
            widthPx: 340,
            header: "Lona",
            libraries: DOCS_LIBRARIES,
            activePath: "/docs/tento-ui-js/list",
            defaultExpanded: false,
            paneLabel: "std-documentation",
          }),
      },
      {
        title: "ux-tests admin — std-admin-page-layout, 240px, never collapses",
        render: () => $adminCard(),
      },
      {
        title: "brand-acme — std-shell-layout + a hand-rolled theme rail, 300px",
        render: () => $acmeCard(),
      },
      {
        title: "commit-review rail — review-rail, 300px, resizable",
        render: () => $reviewRailCard(),
      },
    ];
  }
}
