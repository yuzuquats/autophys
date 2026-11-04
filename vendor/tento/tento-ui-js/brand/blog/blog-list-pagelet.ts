import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { BlogSearchFilterBar } from "./blog-search-filter-bar";

@component({ name: "std-blog-list-pagelet" })
export class BlogListPagelet extends LonaWebComponent {
  private revealFallback: Option<number> = null;

  static makeWith(props: BlogListPagelet.Props): BlogListPagelet {
    return (BlogListPagelet.make() as BlogListPagelet).bind(props);
  }

  bind(props: BlogListPagelet.Props): this {
    props.hero.slot = "hero";
    props.searchFilter.slot = "search-filter";
    props.listView.slot = "list-view";
    for (const child of [...this.children]) {
      if (["hero", "search-filter", "list-view"].includes(child.getAttribute("slot") ?? "") &&
        ![props.hero, props.searchFilter, props.listView].includes(child as HTMLElement)) child.remove();
    }
    this.append(props.hero, props.searchFilter, props.listView);
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // Safety net: reveal even if the controller's stable-layout signal never
    // arrives (e.g. a failed fetch), so the blog can't get stuck invisible.
    // (Search-bar visibility is owned by the index route, keyed off the post
    // count — see list-route.ts — so the pagelet no longer measures the list.)
    this.revealFallback = window.setTimeout(
      () => $$.mutate(() => this.classList.add("blog-ready")),
      800,
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.revealFallback != null) {
      clearTimeout(this.revealFallback);
      this.revealFallback = null;
    }
  }

  static $html = html`
    <std-col>
      <slot name="hero"></slot>
      <slot name="search-filter"></slot>
      <slot name="list-view"></slot>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        /* Keep the blog body at least a full viewport so the footer always
           sits below the fold. */
        min-height: 100vh;

        /* Stay invisible until the controller marks the layout stable
           (.blog-ready), so the search bar's post-measure show/hide and the
           ?test 1->N data swap never flash. min-height holds the page height
           steady while hidden. */
        opacity: 0;
        transition: opacity 0.18s ease;

        /* One content frame + date-rail columns shared by the hero (so.lona)
           and the post rows (tento). Custom properties cross shadow boundaries,
           so the slotted hero and the search/list shadow roots all read these —
           the hero text and post titles land in the same grid column without a
           magic offset. */
        --blog-content-max: 860px;
        --blog-date-col: 100px;
        --blog-rail-gap: 32px;
      }

      :host(.blog-ready) {
        opacity: 1;
      }
    `,
  ];
}

export namespace BlogListPagelet {
  type Slottable = Element & { slot: string };

  export type Props = {
    hero: Slottable;
    searchFilter: BlogSearchFilterBar;
    listView: Slottable;
  };
}
