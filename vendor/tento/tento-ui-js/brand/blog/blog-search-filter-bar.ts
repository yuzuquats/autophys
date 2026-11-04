import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { BlogUi } from "./blog-ui";
import { Hotkeys } from "../../hotkeys";

export type BlogCategory =
  | "product"
  | "research"
  | "engineering"
  | "company"
  | "announcements";

@component({ name: "std-blog-search-filter-bar" })
export class BlogSearchFilterBar extends LonaWebComponent {
  private $searchInput: HTMLInputElement = this.$(
    "search-input",
  ) as HTMLInputElement;
  private $filterContainer: HTMLElement = this.$("filter-container");

  private categories: BlogCategory[] = [];
  private activeCategory: Option<BlogCategory> = null;
  private onSearch?: (query: string) => void;
  private onFilterCategory?: (category: BlogCategory) => void;
  private pillByCategory: Map<BlogCategory, HTMLElement> = new Map();

  static makeWith(props: BlogSearchFilterBar.Props): BlogSearchFilterBar {
    return (BlogSearchFilterBar.make() as BlogSearchFilterBar).bind(props);
  }

  connectedCallback() {
    super.connectedCallback();
    this.$searchInput.onkeydown = this.$searchInput.onkeyup = (e) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      if (!hotkey) return;
      if (Hotkeys.allowedHotkeyInEditor(hotkey)) return;
      if (Hotkeys.shouldPreventDefault(hotkey)) e.preventDefault();
      e.stopPropagation();
    };
  }

  bind(props: BlogSearchFilterBar.Props): this {
    this.categories = props.categories;
    this.activeCategory = props.activeCategory ?? null;
    this.onSearch = props.onSearch;
    this.onFilterCategory = props.onFilterCategory;
    BlogUi.components.input.bind(this.$searchInput, {
      variant: "search", label: "Search posts", value: props.query ?? "",
      placeholder: "Search posts", onInput: value => this.onSearch?.(value),
    });

    this.renderFilters();
    return this;
  }

  private renderFilters(): void {
    const desiredPills: HTMLElement[] = [];
    const desiredCategories = new Set(this.categories);
    for (const category of this.categories) {
      let $pill = this.pillByCategory.get(category);
      if (!$pill) {
        $pill = document.createElement("button");
        $pill.textContent = category;
        $pill.className = "filter-pill";
        ($pill as HTMLButtonElement).type = "button";
        $pill.onclick = () => this.onFilterCategory?.(category);
        this.pillByCategory.set(category, $pill);
      }

      BlogUi.components.button.bind($pill as HTMLButtonElement, { variant: "filter", text: category, pressed: category === this.activeCategory });
      desiredPills.push($pill);
    }

    for (const [category, $pill] of this.pillByCategory.entries()) {
      if (desiredCategories.has(category)) continue;
      DomUtils.removeFromDom($pill);
      this.pillByCategory.delete(category);
    }

    DomUtils.reconcileChildren(this.$filterContainer, desiredPills);
    this.$filterContainer.classList.toggle("hidden", desiredPills.length === 0);
  }

  updateActiveCategory(category: Option<BlogCategory>): void {
    this.activeCategory = category;
    this.renderFilters();
  }

  static $html = html`
    <div id="container">
      <input type="text" id="search-input" placeholder="Search posts" aria-label="Search posts" />
      <div id="filter-container" role="group" aria-label="Post categories"></div>
    </div>
  `;

  static $styles = [
    css(`
      :host {
        display: block;
        padding: 32px 40px;
        background: var(--bg);
        border-bottom: 1px solid var(--divider);
      }

      /* Hidden by the blog index route (list-route.ts) when the blog has fewer
         than its minimum post count — search isn't worth showing for a handful. */
      :host(.hidden) {
        display: none;
      }

      #container {
        max-width: var(--blog-content-max, 860px);
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      #search-input {
        width: 100%;
        padding: 12px 0;
        --font-size: var(--blog-search-input-size, var(--text-15px));
        border: none;
        border-bottom: 1px solid var(--divider);
        border-radius: 0;
        outline: none;
        transition: border-color 0.2s ease;
        background: transparent;
      }

      #search-input:focus {
        border-bottom-color: var(--text-pri);
      }

      #search-input::placeholder {
        color: var(--text-ter);
      }

      #filter-container {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }

      #filter-container.hidden {
        display: none;
      }

      .filter-pill { ${BlogUi.buttonStyle.filter} }

      .filter-pill:hover {
        color: var(--text-pri);
      }

      .filter-pill.active {
        color: var(--text-pri);
        font-weight: 500;
      }
    `),
  ];
}

export namespace BlogSearchFilterBar {
  export type Props = {
    categories: BlogCategory[];
    query?: string;
    activeCategory?: Option<BlogCategory>;
    onSearch?: (query: string) => void;
    onFilterCategory?: (category: BlogCategory) => void;
  };
}
