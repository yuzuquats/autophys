import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-blog-bear-post-pagelet" })
export class BlogBearPostPagelet extends LonaWebComponent {
  static makeWith(props: BlogBearPostPagelet.Props): BlogBearPostPagelet {
    return (BlogBearPostPagelet.make() as BlogBearPostPagelet).bind(props);
  }

  bind(props: BlogBearPostPagelet.Props): this {
    props.content.slot = "content";
    this.append(props.content);
    return this;
  }

  static $html = html`
    <std-col id="root">
      <slot name="title"></slot>
      <slot name="meta"></slot>
      <slot name="content"></slot>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
      }

      #root {
        max-width: var(--max-width, 720px);
        margin: 0 auto;
        padding: 0px var(--brand-inline-padding, 40px) 80px;
        box-sizing: border-box;
        gap: 0px;
      }
    `,
  ];
}

export namespace BlogBearPostPagelet {
  export type Props = {
    content: HTMLElement;
  };
}
