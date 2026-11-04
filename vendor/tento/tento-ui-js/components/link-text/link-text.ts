import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { LinkIcon } from "../../icon-exports";
import { LonaIcons } from "../../ui/icons";

// A hyperlink that says when it leaves the page. `std-anchor` is a popover
// trigger and `components/link/link.ts` is a style namespace; this is the
// element. A native `<a>` in the shadow carries the whole contract — focus,
// Enter, the context menu, middle-click — so nothing is reimplemented.
// `external` adds `rel=noopener target=_blank`, the link glyph (decorative),
// and a hidden "(opens in new tab)" the reader hears and the eye does not.
//
// `onClick` is a callback riding the anchor's OWN click event, not a gesture
// installed beside it: Enter and pointer must produce the same event (R1),
// and a caller that wants to route instead of navigate calls
// `preventDefault` on it. The listener is installed once, on an own-shadow
// node, and reads the current props — it survives pooling by construction.
@component({ name: "std-link" })
export class LinkText extends LonaWebComponent {
  private $a: HTMLAnchorElement = this.$("a");
  private $text: HTMLElement = this.$("text");
  private $glyph: HTMLElement = this.$("glyph");
  private $hint: HTMLElement = this.$("hint");
  private props: Option<LinkText.Props>;

  constructor() {
    super();
    this.$a.addEventListener("click", (e) => this.props?.onClick?.(e));
    this.$glyph.appendChild(LonaIcons.$svg(LinkIcon));
  }

  bind(props: LinkText.Props): this {
    this.props = props;
    this.$a.href = props.href;
    this.$text.textContent = props.text;
    if (props.external) {
      this.$a.setAttribute("rel", "noopener");
      this.$a.setAttribute("target", "_blank");
    } else {
      this.$a.removeAttribute("rel");
      this.$a.removeAttribute("target");
    }
    this.$glyph.toggleAttribute("hidden", !props.external);
    this.$hint.toggleAttribute("hidden", !props.external);
    this.setAttribute("tone", props.tone ?? "default");
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$a.removeAttribute("href");
    this.$a.removeAttribute("rel");
    this.$a.removeAttribute("target");
    this.$text.textContent = "";
    this.$glyph.toggleAttribute("hidden", true);
    this.$hint.toggleAttribute("hidden", true);
    this.removeAttribute("tone");
  }

  static makeWith(props: LinkText.Props): LinkText {
    return LinkText.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --link-color: var(--link-color-preset, var(--blue));
        --link-underline: var(--link-underline-preset, underline);
        --link-gap: 3px;

        display: inline;
      }

      :host([tone="quiet"]) {
        --link-color-preset: var(--text-sec);
        --link-underline-preset: none;
      }

      a {
        color: var(--link-color);
        text-decoration: var(--link-underline);
        text-underline-offset: 2px;
        cursor: pointer;
        border-radius: 2px;
      }

      a:hover {
        text-decoration: underline;
      }

      /* The focus ring is the browser's; it is never removed, only shaped. */
      a:focus-visible {
        outline: 2px solid var(--link-color);
        outline-offset: 2px;
      }

      #glyph {
        display: inline-flex;
        width: 0.85em;
        height: 0.85em;
        margin-inline-start: var(--link-gap);
        vertical-align: -0.1em;
      }

      #glyph > svg {
        width: 100%;
        height: 100%;
        fill: currentColor;
      }

      #glyph[hidden],
      #hint[hidden] {
        display: none;
      }

      /* The clip-rect pattern, inline: this text is for the reader only. */
      #hint {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        clip-path: inset(50%);
        white-space: nowrap;
      }
    `,
  ];

  static $html = html`
    <a id="a"><span id="text"></span><span id="glyph" aria-hidden="true" hidden></span><span id="hint" hidden>(opens in new tab)</span></a>
  `;
}

export namespace LinkText {
  export type Props = {
    href: string;
    text: string;
    /** Opens in a new tab, says so, and carries `rel=noopener`. */
    external: boolean;
    /** Rides the anchor's own click; call `preventDefault` to route instead of navigate. */
    onClick: Option<(e: MouseEvent) => void>;
    tone: Option<"default" | "quiet">;
  };
}
