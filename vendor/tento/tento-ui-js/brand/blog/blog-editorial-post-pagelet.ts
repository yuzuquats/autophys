import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Tracing } from "@tento-core/tracing";

@component({ name: "std-blog-editorial-post-pagelet" })
export class BlogEditorialPostPagelet extends LonaWebComponent {
  private contentGeneration = 0;

  /** Own the outer asynchronous boundary as well as the editor's inner work. */
  async runContentTask(task: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const generation = this.contentGeneration;
    try { await task(() => generation === this.contentGeneration); }
    catch (error) { Tracing.warn("ui")(`Blog article content failed: ${error}`); }
  }

  invalidateContent(): void { this.contentGeneration++; }

  disconnectedCallback(): void {
    this.invalidateContent();
    super.disconnectedCallback();
  }

  static makeWith(
    props: BlogEditorialPostPagelet.Props,
  ): BlogEditorialPostPagelet {
    return (BlogEditorialPostPagelet.make() as BlogEditorialPostPagelet).bind(
      props,
    );
  }

  bind(props: BlogEditorialPostPagelet.Props): this {
    this.invalidateContent();
    props.heroImage.slot = "hero-image";
    props.content.slot = "content";
    props.back.slot = "back";

    if (props.title) props.title.slot = "title";
    if (props.meta) props.meta.slot = "meta";
    if (props.category) props.category.slot = "category";
    const owned = [props.category, props.heroImage, props.content, props.back, props.title, props.meta]
      .filter((node): node is HTMLElement => !!node);
    for (const child of [...this.children]) {
      if (["category", "hero-image", "content", "back", "title", "meta"].includes(child.getAttribute("slot") ?? "") &&
        !owned.includes(child as HTMLElement)) child.remove();
    }
    this.append(...owned);
    return this;
  }

  static $html = html`
    <div id="header">
      <slot name="back"></slot>
      <slot name="category"></slot>
      <slot name="title"></slot>
      <slot name="meta"></slot>
    </div>
    <div id="hero">
      <slot name="hero-image"></slot>
    </div>
    <div id="body">
      <slot name="content"></slot>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      #header {
        max-width: 680px;
        margin: 0 auto;
        padding: 64px var(--brand-inline-padding, 40px) 48px;
        box-sizing: border-box;
      }

      #hero {
        max-width: var(--max-width, 1080px);
        margin: 0 auto;
        padding: 0 var(--brand-inline-padding, 40px);
        box-sizing: border-box;
      }

      ::slotted([slot="hero-image"]) {
        width: 100%;
        display: block;
      }

      #body {
        max-width: 680px;
        margin: 0 auto;
        padding: 64px var(--brand-inline-padding, 40px) 96px;
        box-sizing: border-box;
      }

      ::slotted([slot="back"]) {
        display: flex;
        align-items: center;
        gap: 12px;
        cursor: pointer;
        margin-bottom: 44px;
        width: fit-content;
      }

      @media (max-width: 768px) {
        #header {
          padding: 40px var(--brand-inline-padding-mobile, 16px) 32px;
        }

        #hero {
          padding: 0 var(--brand-inline-padding-mobile, 16px);
        }

        #body {
          padding: 40px var(--brand-inline-padding-mobile, 16px) 72px;
        }
      }
    `,
  ];
}

export namespace BlogEditorialPostPagelet {
  export type Props = {
    heroImage: HTMLElement;
    content: HTMLElement;
    back: HTMLElement;
    category?: Option<HTMLElement>;
    title?: HTMLElement;
    meta?: HTMLElement;
  };
}
