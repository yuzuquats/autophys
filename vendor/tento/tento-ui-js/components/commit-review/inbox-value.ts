import { LonaWebComponent, html } from "../../component";
import { Avatar } from "../avatar";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { $inboxPips, InboxPip } from "./inbox-pips";
import { StackLog } from "./stack-log";

// One field column's cell in the review inbox — the right-hand strip of a
// table, so it right-aligns with tabular figures (the eye reads those by
// their right edge). Its own component for the same reason as the primary
// cell: a table cell mounts inside `std-table-body`'s shadow root, out of
// reach of the inbox's stylesheet. A pure primitive — it binds one string
// and knows nothing about fields (`inbox-value.example.ts` is its
// storybook).

@component({ name: "std-review-inbox-value" })
export class InboxValue extends LonaWebComponent {
  private $text: HTMLElement = this.$("text");

  /** The action face's target. Registered ONCE (cells are recycled — a
   * handler added per bind would stack), dispatched through whatever the
   * latest bind installed; the passive faces install null. */
  private onAction: Option<() => void> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this, {
      onClick: () => this.onAction?.(),
    });
  }

  /** `href` makes the value a link — the `id` column is the live case, where
   * the value IS an address. Everything else passes null and renders as
   * before. */
  bind(text: string, href: Option<string> = null): void {
    this.onAction = null;
    this.toggleAttribute("action", false);
    this.toggleAttribute("agent-active", false);
    const empty = text === "";
    // An empty cell still holds its column open; a dim middot says "nothing
    // here" without reading as a value.
    if (empty) this.$text.textContent = "·";
    else if (href == null) this.$text.textContent = text;
    else this.$text.replaceChildren(StackLog.$handleLink(text, href));
    this.toggleAttribute("dim", empty);
  }

  /** The value as a door: same right-aligned figure, but clicking it acts.
   * The cell stays a primitive — it renders one string and reports one
   * click; what the click means belongs to the binder. */
  bindAction(text: string, onOpen: () => void): void {
    this.onAction = onOpen;
    this.toggleAttribute("agent-active", false);
    this.$text.textContent = text === "" ? "·" : text;
    this.toggleAttribute("dim", text === "");
    this.toggleAttribute("action", true);
  }

  /** The agent face: a harness mark instead of a glyph, and still a door.
   *
   * Same contract as `bindAction` — one click out, the binder decides what it
   * means — but the payload is an avatar rather than text, because "which
   * agent" is an identity and identities are drawn, not spelled. `active`
   * rings the mark; it is the one place this cell blends two facts, and it
   * earns that because they are facts about the same agent. */
  bindAgent(face: Avatar.Props, active: boolean, onOpen: () => void): void {
    this.onAction = onOpen;
    const $avatar = Avatar.makeWithInitials(face);
    this.$text.replaceChildren($avatar);
    this.toggleAttribute("dim", false);
    this.toggleAttribute("action", true);
    this.toggleAttribute("agent-active", active);
  }

  bindPips(pips: InboxPip[]): void {
    this.onAction = null;
    this.toggleAttribute("action", false);
    this.toggleAttribute("agent-active", false);
    this.$text.replaceChildren(
      ...(pips.length > 0 ? [$inboxPips(pips)] : [document.createTextNode("·")]),
    );
    this.toggleAttribute("dim", pips.length === 0);
  }

  static $styles = [
    Typography.$style,
    StackLog.HANDLE_CSS,
    css`
      :host {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        width: 100%;
        min-width: 0;
      }
      :host([dim]) #text {
        opacity: 0.45;
      }
      /* The action face reads as tappable without becoming a button: the
         value brightens under the pointer, and the cursor is the promise. */
      :host([action]) {
        cursor: pointer;
      }
      :host([action]) #text {
        color: var(--text-sec);
      }
      :host([action]:hover) #text {
        color: var(--text-pri);
      }
      /* The working light. A ring rather than a badge: at 16px a badge is
         bigger than the mark it decorates, and the ring reads as "this one is
         lit" without adding a second object to scan. Drawn on the avatar
         itself so it follows the squircle instead of boxing it. */
      :host([agent-active]) #text std-avatar {
        border-radius: 50%;
        box-shadow: 0 0 0 1.5px var(--fg-green);
      }
      /* A box-shadow ring is painted OUTSIDE the 16px mark, and #text clips —
         it has to, so long values ellipsize. The agent face is a single
         element with nothing to truncate, so it is the one face that can give
         the clip up, and it must: with it on, the ring computes correctly and
         paints nowhere — the shadow read back green off getComputedStyle
         while the screenshot showed no ring at all. */
      :host([agent-active]) #text {
        overflow: visible;
      }
      #text {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
        text-align: right;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<p id="text" class="small"></p>`;
}
