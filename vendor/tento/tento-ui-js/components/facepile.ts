import "./avatar";

import { html, LonaWebComponent } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { DomUtils } from "../dom";
import { Avatar } from "./avatar";

// A Props model for the avatar stack. This had no `bind`: size arrived as an
// attribute, children were appended by the caller, and there was no "+N". It
// now renders `std-avatar`s from `Props` — with an initials avatar for the
// overflow past `max` — and names the group. The slot stays for the callers
// that still compose their own faces; a bound pile and a slotted pile draw the
// same ring.
@component({
  name: "std-facepile",
})
export class Facepile extends LonaWebComponent {
  private $faces: HTMLElement = this.$("faces");

  bind(props: Facepile.Props): this {
    this.setAttribute("size", String(props.sizePx));
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", `${props.avatars.length} ${props.avatars.length === 1 ? "person" : "people"}`);
    DomUtils.clearChildren(this.$faces);
    const shown = props.avatars.slice(0, props.max);
    const rest = props.avatars.length - shown.length;
    for (const a of shown) this.$faces.appendChild(Avatar.makeWithInitials({ ...a, size: Facepile.avatarSize(props.sizePx) }));
    if (rest > 0) {
      this.$faces.appendChild(
        Avatar.makeWithInitials({
          initials: `+${rest}`,
          backgroundColor: "var(--bg-surface-light)",
          color: "var(--text-sec)",
          size: Facepile.avatarSize(props.sizePx),
        }),
      );
    }
    return this;
  }

  private static avatarSize(px: number): Avatar.Props["size"] {
    if (px <= 16) return "16";
    if (px <= 20) return "20";
    if (px <= 24) return "24";
    if (px <= 32) return "32";
    return "40";
  }

  onRecycle(): void {
    super.onRecycle();
    DomUtils.clearChildren(this.$faces);
    for (const a of ["size", "role", "aria-label"]) this.removeAttribute(a);
  }

  static makeWith(props: Facepile.Props): Facepile {
    return Facepile.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --facepile-overlap: var(--facepile-overlap-preset, 8px);
        --facepile-border: var(--std-facepile-border-color, var(--bg));

        display: inline-flex;
        max-width: max-content;
      }

      :host([size="16"]) {
        --_dim: 16px;
      }
      :host([size="20"]) {
        --_dim: 20px;
      }
      :host([size="24"]) {
        --_dim: 24px;
      }
      :host([size="28"]) {
        --_dim: 28px;
      }
      :host([size="32"]) {
        --_dim: 32px;
      }

      #faces {
        display: contents;
      }

      #faces > *,
      slot::slotted(*) {
        margin-right: calc(-1 * var(--facepile-overlap));
        border: 2px solid var(--facepile-border);
        border-radius: 50%;
      }

      #faces > *:last-child,
      slot::slotted(*:last-child) {
        margin-right: 0px;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row>
      <span id="faces"></span>
      <slot></slot>
    </std-row>
  `;
}

export namespace Facepile {
  export type Props = {
    avatars: Avatar.Props[];
    /** Faces drawn before the "+N" overflow avatar. */
    max: number;
    sizePx: number;
  };
}
