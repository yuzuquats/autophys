import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";

// A bar of app chrome: the 40px row at an app's top edge, and the same row a
// page puts under it for its own title and controls.
//
//   [start] | title ..................... meta [controls]
//
// Brand Acme's top bar and Artifacts' top bar were the same forty lines of CSS
// written twice, down to the 16px separator, and the Artifacts feed drew its
// own heading under them in a third shape. This is the one anatomy for all of
// them, so a bar looks the same wherever it appears:
//
//   - start ...... slot="start", the leading control (the sidebar expand
//                  button). A separator follows it only when it is filled.
//   - title ...... the app or page name. A label, not a heading. A page bar
//                  may slot an element there instead (slot="title"), such as
//                  a small std-breadcrumb; it shrinks before the controls do.
//   - meta ....... a quiet status line held to the trailing side, just before
//                  the controls: "Design systems", "3 to review".
//   - controls ... the default slot: dropdowns, a segmented filter, icon
//                  buttons. Put an element with class app-bar-sep between two
//                  groups to draw the same separator.
//
// The bar draws its own hairline at the bottom edge. That divider is the whole
// separation between the bar and what scrolls under it; there is no shadow.
//
// Controls stay in the caller's light DOM, so the caller's own styles still
// reach them. The bar pins the system UI face on itself and they inherit it,
// so a bar reads identically under any page or brand typography.
//
// Height is --app-bar-height (40px). A surface that needs a taller bar, such as
// a phone layout with a safe-area inset, sets that variable and padding-top on
// the element from outside.
@component({ name: "std-app-bar" })
export class AppBar extends LonaWebComponent {
  /** The title label. Written by `bind`; exposed for aria wiring. */
  readonly $title: HTMLElement = this.$("title");
  /** The meta line. A caller that updates it often (a live count) may write
   * its text directly instead of rebinding. */
  readonly $meta: HTMLElement = this.$("meta");
  private $start: HTMLSlotElement = this.$("start");

  constructor() {
    super();
    this.$start.addEventListener("slotchange", this.syncStart);
  }

  bind(props: AppBar.Props): this {
    this.$title.textContent = props.title;
    this.$meta.textContent = props.meta ?? "";
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.$title.textContent = "";
    this.$meta.textContent = "";
    this.removeAttribute("has-start");
  }

  private syncStart = (): void => {
    this.toggleAttribute("has-start", this.$start.assignedElements().length > 0);
  };

  static makeWith(props: AppBar.Props): AppBar {
    return AppBar.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: 2px;
        /* A flex item of the shell's column. Without the zero shrink the bar
           collapses to its content height whenever the page beside it is taller
           than the viewport. */
        flex: 0 0 auto;
        box-sizing: border-box;
        width: 100%;
        height: var(--app-bar-height, 40px);
        min-width: 0;
        padding: 0 8px;
        border-bottom: 1px solid var(--divider);
        background: var(--bg);
        font-family: -apple-system, system-ui, sans-serif;
      }

      :host([hidden]) {
        display: none;
      }

      #sep,
      ::slotted(.app-bar-sep) {
        flex: 0 0 1px;
        width: 1px;
        height: 16px;
        margin-inline: 8px;
        background: var(--divider);
      }

      #sep {
        display: none;
      }

      :host([has-start]) #sep {
        display: block;
      }

      /* The real margin properties, never the --margin-top variable: the label
         sits in a fixed-height centred row, and the type ramp's optical trim
         would otherwise shift it off centre. */
      #title,
      #meta {
        flex: 0 1 auto;
        min-width: 0;
        margin-top: 0px;
        margin-bottom: 0px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* The title holds its width and the meta gives way first: on a narrow
         bar the page name stays readable and the status line truncates. A
         very long title still ellipsizes past half the bar. */
      #title {
        flex: 0 0 auto;
        max-width: 50%;
        --font-size: var(--text-9px);
        font-weight: 500;
        color: var(--text-sec);
      }

      #meta {
        --font-size: var(--text-8px);
        margin-inline-end: 8px;
        color: var(--text-ter);
        font-variant-numeric: tabular-nums;
      }

      #title:empty,
      #meta:empty {
        display: none;
      }

      ::slotted([slot="title"]) {
        flex: 0 1 auto;
        min-width: 0;
      }

      #spacer {
        flex: 1 1 auto;
        min-width: 0;
      }
    `,
  ];

  static $html = html`
    <slot name="start" id="start"></slot>
    <i id="sep" aria-hidden="true"></i>
    <slot name="title"><p id="title" class="small"></p></slot>
    <span id="spacer"></span>
    <p id="meta" class="small"></p>
    <slot></slot>
  `;
}

export namespace AppBar {
  export type Props = {
    /** The app or page name. `""` draws no label. */
    title: string;
    /** The quiet status line beside the controls. Null or `""` hides it. */
    meta?: Option<string>;
  };
}
