import "../../init";
import "../shell-layout/shell-layout";
import "../docs-nav/docs-nav";
import "../documentation/documentation";
import "../breadcrumb/breadcrumb";

import { nonnull } from "@tento-core/assert";

import { $, $_maybe } from "../../dom-selectors";
import { DomUtils } from "../../dom";
import { Breadcrumb } from "../breadcrumb/breadcrumb";
import { DocsNav } from "../docs-nav/docs-nav";
import { Documentation } from "../documentation/documentation";
import { ShellLayout } from "../shell-layout/shell-layout";
import { SidebarExpandButton } from "../sidebar/sidebar-expand-button";

/**
 * Per-surface configuration for {@link initDocsShell}. The shell owns the docs
 * orchestration — reading SSR state, SPA navigation, title, popstate, nav
 * binding, the data-driven breadcrumb, and content loading — and drives a
 * generic `std-shell-layout` (which owns only the responsive layout + sidebar
 * collapse). Surface-specific behavior arrives through the callbacks below so
 * the shell stays free of app/`@tento-lona` dependencies.
 */
export type DocsShellConfig = {
  layoutId: string;
  /** The `std-docs-nav` slotted into the layout's `sidebar` slot. */
  navId: string;
  /** The `std-documentation` slotted into the layout's `content` slot. */
  contentId: string;
  breadcrumbId: Option<string>;
  expandButtonId: string;
  pathPrefix: string;
  fallbackTitle: string;
  titleSuffix: string;
  /**
   * Surface marker prepended to the document title, e.g. `"Dev | "` for
   * internal tooling or `"Admin | "` for the admin console. Empty string for
   * user-facing surfaces. Keeps internal tabs distinguishable from product tabs.
   */
  titlePrefix: string;
  /** Where the initial TOC and optional first page come from. SSR-backed
   * surfaces read their injected scripts; static SPAs can provide the TOC and
   * deliberately load the current pathname through `loadMarkdown`. */
  initialState: DocsShell.InitialState;
  libraryIcon: Option<DocsNav.LibraryIconResolver>;
  /** Force the TOC fully expanded, ignoring saved (shared) collapse state. */
  defaultExpanded?: Option<boolean>;
  geometry: ShellLayout.Geometry;
  breadcrumbRoot: (info: DocsShell.PageInfo) => DocsShell.Crumb[];
  loadMarkdown: (
    path: string,
    info: DocsShell.PageInfo,
    libraries: DocsNav.NavLibrary[],
  ) => Promise<Option<string>>;
  contentOptionsForPath: (
    info: DocsShell.PageInfo,
  ) => Promise<Pick<Documentation.Props, "serde" | "nodeViews" | "inlineCodeLanguage">>;
};

function readJsonScript<T>(id: string, pathPrefix: string): T {
  const $script = nonnull(
    document.getElementById(id),
    `${pathPrefix} route state script missing: ${id}`,
  );
  const raw = nonnull(
    $script.textContent,
    `${pathPrefix} route state script is empty: ${id}`,
  );
  return JSON.parse(raw) as T;
}

export async function initDocsShell(
  config: DocsShellConfig,
): Promise<DocsShell.Controller> {
  const initialState = DocsShell.resolveInitialState(
    config.initialState,
    config.pathPrefix,
  );
  const navLibraries = initialState.libraries;
  const pageMarkdown = initialState.pageMarkdown;

  const $layout = $<ShellLayout>(config.layoutId);
  const $nav = $<DocsNav>(config.navId);
  const $content = $<Documentation>(config.contentId);
  const $breadcrumb =
    config.breadcrumbId != null
      ? $_maybe<Breadcrumb>(config.breadcrumbId)
      : null;
  const $expandButton = $_maybe<SidebarExpandButton>(config.expandButtonId);
  let disposed = false;

  function pathFromLocation(): string {
    return location.pathname.replace(/\/$/, "") || config.pathPrefix;
  }

  function pageInfo(path: string): DocsShell.PageInfo {
    return DocsShell.pageInfoFromPath(
      navLibraries,
      path,
      config.fallbackTitle,
      config.pathPrefix,
    );
  }

  function pageTitle(info: DocsShell.PageInfo): string {
    return `${config.titlePrefix}${info.title} — ${config.titleSuffix}`;
  }

  // Data-driven breadcrumb: resolve the path to its page metadata and render
  // the crumb trail (surface-specific leading crumb via `breadcrumbRoot`).
  function renderBreadcrumb(path: string): void {
    if ($breadcrumb == null) return;
    const info = pageInfo(path);
    const crumbs = DocsShell.buildCrumbs(
      info,
      config.pathPrefix,
      config.fallbackTitle,
      config.breadcrumbRoot,
    );
    DomUtils.clearChildren($breadcrumb);
    for (const crumb of crumbs) {
      $breadcrumb.append(
        crumb.kind === "link"
          ? Breadcrumb.Link(crumb.label, crumb.href)
          : Breadcrumb.Label(crumb.label),
      );
    }
  }

  async function showPath(
    path: string,
    options: { cached: Option<string>; push: boolean },
  ): Promise<void> {
    const nextPath = path.replace(/\/$/, "") || config.pathPrefix;
    const info = pageInfo(nextPath);
    const markdown =
      options.cached ?? (await config.loadMarkdown(nextPath, info, navLibraries));
    if (disposed) return;
    if (markdown == null) {
      location.href = nextPath;
      return;
    }
    if (options.push) {
      history.pushState(null, "", nextPath);
    }
    const extra = await config.contentOptionsForPath(info);
    if (disposed) return;
    document.title = pageTitle(info);
    $nav.setActivePath(nextPath);
    renderBreadcrumb(nextPath);
    await $content.bind({ markdown, ...extra });
    $layout.resetContentScroll();
  }

  function navigateTo(path: string): void {
    const nextPath = path.replace(/\/$/, "") || config.pathPrefix;
    $layout.closeMobileNav();
    if (nextPath === pathFromLocation()) return;
    void showPath(nextPath, { cached: null, push: true });
  }

  // Intercept same-origin in-content links to docs paths → SPA navigation.
  function handleContentClick(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const $anchor = event
      .composedPath()
      .find((node) => node instanceof HTMLAnchorElement) as
      | Option<HTMLAnchorElement>;
    if ($anchor == null) return;
    const href = $anchor.getAttribute("href");
    if (href == null || href.startsWith("#")) return;
    const url = new URL(href, location.href);
    const isDocsPath =
      url.pathname === config.pathPrefix ||
      url.pathname.startsWith(`${config.pathPrefix}/`);
    if (url.origin !== location.origin || !isDocsPath) return;
    event.preventDefault();
    navigateTo(url.pathname);
  }

  function handlePopState(): void {
    const path = pathFromLocation();
    const isDocsPath =
      path === config.pathPrefix || path.startsWith(`${config.pathPrefix}/`);
    if (!isDocsPath) return;
    void showPath(path, { cached: null, push: false });
  }

  $content.addEventListener("click", handleContentClick);
  window.addEventListener("popstate", handlePopState);

  const activePath = pathFromLocation();

  $layout.bind({ geometry: config.geometry, expandButton: $expandButton });
  $nav.bind({
    items: navLibraries,
    activePath,
    onNavigate: navigateTo,
    iconForLibrary: config.libraryIcon,
    defaultExpanded: config.defaultExpanded ?? false,
  });

  await showPath(activePath, { cached: pageMarkdown, push: false });
  await DomUtils.hydrateAndReveal();
  return {
    dispose: () => {
      disposed = true;
      $content.removeEventListener("click", handleContentClick);
      window.removeEventListener("popstate", handlePopState);
    },
  };
}

export namespace DocsShell {
  export type Controller = {
    dispose: EmptyFunction;
  };

  export type InitialState =
    | { kind: "scripts" }
    | {
      kind: "provided";
      libraries: DocsNav.NavLibrary[];
      pageMarkdown: Option<string>;
    };

  export type ResolvedInitialState = {
    libraries: DocsNav.NavLibrary[];
    pageMarkdown: Option<string>;
  };

  export function resolveInitialState(
    state: InitialState,
    pathPrefix: string,
  ): ResolvedInitialState {
    if (state.kind === "provided") {
      return {
        libraries: state.libraries,
        pageMarkdown: state.pageMarkdown,
      };
    }
    const toc = readJsonScript<{ libraries: DocsNav.NavLibrary[] }>(
      "docs-toc-json",
      pathPrefix,
    );
    return {
      libraries: toc.libraries,
      pageMarkdown: readJsonScript<string>("docs-page-markdown", pathPrefix),
    };
  }

  export type Crumb =
    | { kind: "link"; label: string; href: string }
    | { kind: "label"; label: string };

  export type PageInfo = {
    title: string;
    libraryTitle: Option<string>;
    libraryNamespace: Option<string>;
    slug: Option<string>;
  };

  /** Resolve a docs path to its page metadata using the nav tree. */
  export function pageInfoFromPath(
    libraries: DocsNav.NavLibrary[],
    path: string,
    fallbackTitle: string,
    pathPrefix: string,
  ): PageInfo {
    if (path === pathPrefix) {
      return {
        title: fallbackTitle,
        libraryTitle: null,
        libraryNamespace: null,
        slug: null,
      };
    }

    for (const library of libraries) {
      if (library.path === path) {
        return {
          title: library.title,
          libraryTitle: null,
          libraryNamespace: library.namespace,
          slug: null,
        };
      }
      for (const section of library.sections) {
        for (const item of section.children) {
          if (item.path === path) {
            return {
              title: item.label,
              libraryTitle: library.title,
              libraryNamespace: library.namespace,
              slug: item.slug,
            };
          }
        }
      }
    }

    const parts = path.split("/").filter(Boolean);
    return {
      title: fallbackTitle,
      libraryTitle: null,
      libraryNamespace: null,
      slug: parts.length > 0 ? parts[parts.length - 1] : null,
    };
  }

  /**
   * Build the breadcrumb trail. `breadcrumbRoot` supplies the surface-specific
   * leading crumb(s) (e.g. "Lona" vs "admin.lona.so"); the shared tail is
   * `Docs › library › page`.
   */
  export function buildCrumbs(
    info: PageInfo,
    pathPrefix: string,
    docsLabel: string,
    breadcrumbRoot: (info: PageInfo) => Crumb[],
  ): Crumb[] {
    const crumbs: Crumb[] = [...breadcrumbRoot(info)];
    const onIndex = info.libraryNamespace == null && info.slug == null;
    if (onIndex) {
      crumbs.push({ kind: "label", label: docsLabel });
      return crumbs;
    }

    crumbs.push({ kind: "link", label: docsLabel, href: pathPrefix });
    if (info.libraryTitle != null) {
      crumbs.push({ kind: "label", label: info.libraryTitle });
    }
    crumbs.push({ kind: "label", label: info.title });
    return crumbs;
  }
}
