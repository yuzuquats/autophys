import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { DomUtils } from "../../dom";
import type { NavDetailsConfig } from "../blog/blog-design-system";
import { NavCenteredPopoverRow } from "../blog/nav-centered-popover-row";
import { selectionForRoute } from "./nav-selection";
import { Brand } from "../brand";

@component({ name: "std-brand-app" })
export class BrandApp extends LonaWebComponent {
  private $content: HTMLDivElement = this.$("content");

  getRoute<T extends HTMLElement>(): Option<T> {
    return this.firstElementChild as Option<T>;
  }

  private loadedFonts = new Set<string>();
  // The chrome (header + its nav mega-menu, breadcrumb, footer) is built once and
  // kept mounted across SPA navigations; only the pagelet is swapped. Tearing the
  // header down and rebuilding it on every navigation would recreate the nav row
  // right under the cursor, firing a synthetic `pointerenter` that re-opens the
  // mega-menu for the link the user just clicked through (and wastes work).
  private $layout: Option<HTMLElement> = null;
  private $currentPagelet: Option<HTMLElement> = null;
  private renderVersion = 0;

  async render(config: BrandApp.Config) {
    const version = ++this.renderVersion;
    // Apply background color to document body. Also expose it as a body-scoped
    // CSS variable: the brand `--bg` token is scoped to this component's shadow
    // tree (Brand.collectTokens -> addStyle), so chrome that Anchor portals out
    // to document.body — e.g. the nav mega-menu popover — sits OUTSIDE that scope
    // and would otherwise fall back to the global elevated white. `--brand-page-bg`
    // lets that portaled chrome match the real page background.
    if (config.ds.bg) {
      document.body.style.backgroundColor = config.ds.bg;
      document.body.style.setProperty("--brand-page-bg", config.ds.bg);
    }

    // Load variant fonts dynamically
    for (const fontCss of config.ds.fonts) {
      if (this.loadedFonts.has(fontCss)) continue;
      this.loadedFonts.add(fontCss);
      const $link = document.createElement("link");
      $link.rel = "stylesheet";
      $link.type = "text/css";
      $link.href = `/@/static/css/${fontCss}`;
      document.head.appendChild($link);
    }

    const tokens = Brand.collectTokens(config.ds);
    if (config.pageStyle) tokens.push(config.pageStyle);
    for (let i = 0; i < tokens.length; i++) {
      this.addStyle(`ds-${i}`, tokens[i]);
    }

    const $pagelet = await config.resolve(this.getRoute());
    // Superseded — a later render() started while this one resolved, or the
    // resolver reports a newer navigation (null): mount nothing, so stale work
    // cannot remove, re-append or refocus the page now showing.
    if (version !== this.renderVersion || !$pagelet) return;
    $pagelet.classList.add("pagelet");
    $pagelet.assignStyles({ flexGrow: "1" });
    $pagelet.slot = "content";

    // Subsequent navigation within an already-rendered app: keep the chrome
    // mounted and swap only the pagelet (the "content" slot). The nav row — and
    // thus its open/closed state — survives, so it is never rebuilt under the
    // cursor. (navConfig/ds are stable across an app's lifetime; cross-variant
    // navigation is a full page load with a fresh BrandApp.)
    if (this.$layout) {
      this.$currentPagelet?.remove();
      this.$layout.appendChild($pagelet);
      this.$currentPagelet = $pagelet;
      this.applyNavSelection(config.navConfig);
      return;
    }

    const $layout = config.ds.layout.makeLayout({
      header: config.ds.nav.header.make(config.navConfig),
      breadcrumb: config.ds.nav.breadcrumb.make(undefined as void),
      footer: config.ds.nav.footer.make(undefined as void),
    });
    $layout.classList.add("chrome-layout");
    $layout.assignStyles({ height: "100%" });
    $layout.appendChild($pagelet);

    DomUtils.clearChildren(this.$content);
    this.$content.appendChild($layout);
    this.$layout = $layout;
    this.$currentPagelet = $pagelet;
    this.applyNavSelection(config.navConfig);
  }

  // Drive the controlled nav from the route. render() runs on EVERY navigation and
  // owns the one live $layout, so it pushes the freshly-computed selection straight
  // to the visible nav row — no Router subscription that could strand listeners on
  // detached rows across re-renders.
  private applyNavSelection(navConfig: BrandApp.NavConfig): void {
    const $navRow = this.$layout?.querySelector<NavCenteredPopoverRow>(
      "std-nav-centered-popover-row",
    );
    if (!$navRow) return;
    $navRow.setSelected(selectionForRoute(navConfig, window.location.pathname));
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        min-height: 100vh;
        color: var(--text-pri);
      }

      #content {
        height: 100%;
      }
    `,
  ];
  static $html = html`<div id="content"></div>`;
}

export namespace BrandApp {
  export type NavConfig = {
    items: {
      label: string;
      href?: Option<string>;
      children?: Option<{ label: string; href?: Option<string> }[]>;
      details?: Option<NavDetailsConfig>;
    }[];
    cta: Option<{ label: string; href?: Option<string> }>;
    onNavigate: (href: string) => void;
  };

  export type Config = {
    ds: Brand.DesignSystem;
    pageStyle: Option<Style.Compat>;
    navConfig: NavConfig;
    /** Null: this navigation was superseded; render() mounts nothing. */
    resolve: (
      route: Option<HTMLElement>,
    ) => Option<HTMLElement> | Promise<Option<HTMLElement>>;
  };
}
