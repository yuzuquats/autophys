import "../link-text/link-text";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";
import { LinkText } from "../link-text/link-text";

// A reference to a source: an optional index, a title that links when there
// is a URL, an optional author. `<cite>` is the element that means it.
@component({ name: "std-citation" })
export class Citation extends LonaWebComponent {
  private $index: HTMLElement = this.$("index");
  private $title: HTMLElement = this.$("title");
  private $author: HTMLElement = this.$("author");

  bind(props: Citation.Props): this {
    const index = props.index;
    this.$index.textContent = index == null ? "" : `[${index}]`;
    this.$index.toggleAttribute("hidden", index == null);
    DomUtils.clearChildren(this.$title);
    if (props.url == null) {
      this.$title.textContent = props.title;
    } else {
      this.$title.appendChild(
        LinkText.makeWith({ href: props.url, text: props.title, external: true, onClick: null, tone: null }),
      );
    }
    const author = props.author;
    this.$author.textContent = author == null ? "" : ` — ${author}`;
    this.$author.toggleAttribute("hidden", author == null);
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.$index.textContent = "";
    DomUtils.clearChildren(this.$title);
    this.$author.textContent = "";
  }

  static makeWith(props: Citation.Props): Citation {
    return Citation.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --citation-color: var(--citation-color-preset, var(--text-sec));

        display: inline;
        color: var(--citation-color);
        --font-size: var(--small-size);
      }

      cite {
        font-style: normal;
      }

      #index {
        font-variant-numeric: tabular-nums;
        color: var(--text-ter);
        margin-inline-end: 4px;
      }

      #index[hidden],
      #author[hidden] {
        display: none;
      }
    `,
  ];

  static $html = html`<cite><span id="index" hidden></span><span id="title"></span><span id="author" hidden></span></cite>`;
}

export namespace Citation {
  export type Props = {
    title: string;
    /** When present the title is an external link. */
    url: Option<string>;
    author: Option<string>;
    /** A footnote number, drawn as `[n]`. */
    index: Option<number>;
  };
}
