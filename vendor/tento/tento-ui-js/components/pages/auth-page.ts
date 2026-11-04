// std-auth-page is now a thin compat composition over the decoupled
// std-auth-shell (round-bg structural shell) + std-auth-content (the auth
// contents). The public tag + named-slot API are unchanged, so existing
// consumers keep working; the signin page composes the shell + content
// directly so it can swap the whole contents on mobile.
//
// Side-effect imports: std-auth-shell / std-auth-content are referenced only in
// the template below, and their class imports are type-only (erased by
// esbuild) — these bare imports keep the custom elements registered.
import "./auth-shell";
import "./auth-content";
// Preserved for backward compat: the examples/signin route registers
// std-sheets-icon transitively through this module (it renders one directly).
import "@tento-ui/components/icons/sheets-icon";

import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Constants } from "@tento-core/constants";

@component({
  name: "std-auth-page",
})
export class AuthPage extends LonaWebComponent {
  onConnected: EmptyFunction = Constants.EMPTY_FUNCTION;

  connectedCallback() {
    super.connectedCallback();
    this.onConnected();
  }

  static $styles = [
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-auth-shell id="root">
      <slot name="side-content" slot="side-content"></slot>
      <std-auth-content>
        <slot name="title" slot="title"></slot>
        <slot name="status" slot="status"></slot>
        <slot name="button" slot="button"></slot>
        <slot name="privacy-policy" slot="privacy-policy"></slot>
        <slot name="tos" slot="tos"></slot>
      </std-auth-content>
    </std-auth-shell>
  `;
}
