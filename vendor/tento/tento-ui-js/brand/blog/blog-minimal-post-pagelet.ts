import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-blog-minimal-post-pagelet" })
export class BlogMinimalPostPagelet extends LonaWebComponent {
  static makeWith(props: BlogMinimalPostPagelet.Props): BlogMinimalPostPagelet {
    return (BlogMinimalPostPagelet.make() as BlogMinimalPostPagelet).bind(props);
  }

  bind(props: BlogMinimalPostPagelet.Props): this {
    props.content.slot = "content";
    props.back.slot = "back";
    this.append(props.content, props.back);
    return this;
  }

  static $html = html`
    <std-col id="root">
      <slot name="title"></slot>
      <slot name="meta"></slot>
      <slot name="content"></slot>
      <slot name="back"></slot>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
      }

      #root {
        max-width: var(--max-width, 840px);
        margin: 0 auto;
        padding: 60px var(--brand-inline-padding, 40px) 80px;
        box-sizing: border-box;
        box-sizing: border-box;
        gap: 0px;
      }

      ::slotted([slot="meta"]) {
        margin-bottom: 24px;
      }

      ::slotted([slot="back"]) {
        margin-top: 40px;
      }
    `,
  ];
}

export namespace BlogMinimalPostPagelet {
  export type Props = {
    content: HTMLElement;
    back: HTMLElement;
  };
}
