import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-blog-bear-pagelet" })
export class BlogBearPagelet extends LonaWebComponent {
  static makeWith(props: BlogBearPagelet.Props): BlogBearPagelet {
    return (BlogBearPagelet.make() as BlogBearPagelet).bind(props);
  }

  bind(props: BlogBearPagelet.Props): this {
    props.title.slot = "title";
    props.search.slot = "search";
    props.list.slot = "list";
    this.append(props.title, props.search, props.list);
    return this;
  }

  static $html = html`
    <std-col id="root">
      <slot name="title"></slot>
      <slot name="search"></slot>
      <slot name="list"></slot>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        max-width: 720px;
        margin: 0 auto;
        padding: 60px 20px 80px;
      }

      ::slotted([slot="title"]) {
        --margin-top: 0px;
        --margin-bottom: 34px;
      }

      ::slotted([slot="search"]) {
        margin-bottom: 44px;
      }
    `,
  ];
}

export namespace BlogBearPagelet {
  type Slottable = Element & { slot: string };

  export type Props = {
    title: Slottable;
    search: Slottable;
    list: Slottable;
  };
}
