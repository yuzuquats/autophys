import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-blog-newsroom-post-pagelet" })
export class BlogNewsroomPostPagelet extends LonaWebComponent {
  static makeWith(
    props: BlogNewsroomPostPagelet.Props,
  ): BlogNewsroomPostPagelet {
    return (BlogNewsroomPostPagelet.make() as BlogNewsroomPostPagelet).bind(
      props,
    );
  }

  bind(props: BlogNewsroomPostPagelet.Props): this {
    props.category.slot = "category";
    props.heroImage.slot = "hero-image";
    props.content.slot = "content";

    // Title and meta are slotted by the brand page engine.
    this.append(
      props.category,
      props.heroImage,
      props.content,
    );

    return this;
  }

  static $html = html`
    <section id="masthead">
      <std-col id="headline">
        <slot name="category"></slot>
        <slot name="title"></slot>
        <slot name="meta"></slot>
      </std-col>
    </section>

    <section id="hero">
      <slot name="hero-image"></slot>
    </section>

    <section id="article">
      <slot name="content"></slot>
    </section>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        color: var(--text-pri);
        background: var(--bg);
      }

      #masthead {
        max-width: 760px;
        margin: 0 auto;
        padding: 84px var(--brand-inline-padding, 40px) 40px;
        box-sizing: border-box;
      }

      #headline {
        align-items: center;
        text-align: center;
        gap: 0px;
      }

      #hero {
        max-width: var(--max-width, 1040px);
        margin: 0 auto;
        padding: 0 var(--brand-inline-padding, 40px) 72px;
        box-sizing: border-box;
      }

      #article {
        max-width: 100%;
      }

      ::slotted([slot="content"]) {
        display: block;
        max-width: 700px;
        margin: 0 auto;
        padding: 72px var(--brand-inline-padding, 40px) 112px;
        box-sizing: border-box;
      }

      @media (max-width: 768px) {
        #masthead {
          padding: 56px var(--brand-inline-padding-mobile, 16px) 36px;
        }

        #hero {
          padding: 0 var(--brand-inline-padding-mobile, 16px) 56px;
        }

        ::slotted([slot="content"]) {
          padding: 56px var(--brand-inline-padding-mobile, 16px) 88px;
        }

      }
    `,
  ];
}

export namespace BlogNewsroomPostPagelet {
  export type Props = {
    category: HTMLElement;
    heroImage: HTMLElement;
    content: HTMLElement;
  };
}
