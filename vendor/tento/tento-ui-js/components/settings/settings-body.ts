import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import type { SettingsRow } from "./settings-row";
import type { SettingsSection } from "./settings-section";

// The column a settings surface's sections sit in: insets and the space
// between sections, so no section carries its own outer margin. It is not a
// page — the header, scrolling and any stack of sub-pages belong to the
// consumer that places it.
//
// Sections and rows stay in the light DOM under it, so a caller that gave
// them ids finds them again with `row(id)` / `section(id)` and updates them
// in place instead of re-rendering the page.
@component({ name: "std-settings-body" })
export class SettingsBody extends LonaWebComponent {
  static makeWith(...$children: HTMLElement[]): SettingsBody {
    const $body = SettingsBody.make();
    $body.append(...$children);
    return $body;
  }

  row(id: string): Option<SettingsRow> {
    return this.querySelector<SettingsRow>(`std-settings-row#${CSS.escape(id)}`);
  }

  section(id: string): Option<SettingsSection> {
    return this.querySelector<SettingsSection>(`std-settings-section#${CSS.escape(id)}`);
  }

  static $styles = [
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--settings-section-gap, 32px);
        padding: var(--settings-body-padding, 20px);
        min-width: 0;
        box-sizing: border-box;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<slot></slot>`;
}
