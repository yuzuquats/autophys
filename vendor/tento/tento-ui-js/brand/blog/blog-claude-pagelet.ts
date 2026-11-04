import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-blog-claude-pagelet" })
export class BlogClaudePagelet extends LonaWebComponent {
  static makeWith(props: BlogClaudePagelet.Props): BlogClaudePagelet {
    return (BlogClaudePagelet.make() as BlogClaudePagelet).bind(props);
  }

  bind(props: BlogClaudePagelet.Props): this {
    props.hero.slot = "hero";
    props.featuredGrid.slot = "featured";
    props.newsTable.slot = "news";
    this.append(props.hero, props.featuredGrid, props.newsTable);
    return this;
  }

  static $html = html`
    <std-col>
      <slot name="hero"></slot>
      <slot name="featured"></slot>
      <slot name="news"></slot>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
      }
    `,
  ];
}

export namespace BlogClaudePagelet {
  type Slottable = Element & { slot: string };

  export type Props = {
    hero: Slottable;
    featuredGrid: Slottable;
    newsTable: Slottable;
  };
}
