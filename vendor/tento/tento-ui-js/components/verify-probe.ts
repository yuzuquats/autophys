import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { GESTURE_MANAGER } from "../gesture-manager";

// A tiny, fully self-contained primitive whose only job is to VERIFY the
// std-storybook-card pipeline end to end. It renders a labeled chip with a
// LIVE click counter, so a review card proves the sandbox both renders the
// component AND runs its scripts (a static render would never increment). It
// imports only the component base and the shared gesture manager that base
// already pulls in, so it always builds standalone — the shape a
// `<std-storybook-card example=…>` expects.
@component({ name: "dev-verify-probe" })
export class VerifyProbe extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");
  private $count: HTMLElement = this.$("count");
  private $bump: HTMLButtonElement = this.$<HTMLButtonElement>("bump");
  private count: number = 0;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$bump, {
      onClick: () => {
        this.count += 1;
        this.$count.textContent = String(this.count);
      },
    });
  }

  bind(props: VerifyProbe.Props): VerifyProbe {
    this.$label.textContent = props.label;
    this.count = props.start;
    this.$count.textContent = String(this.count);
    return this;
  }

  static $styles = [
    css`
      :host {
        display: inline-block;
      }
      #root {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-radius: 10px;
        border: 1px solid var(--divider);
        background: var(--bg-elevated);
        font: 13px/1.4 -apple-system, system-ui, sans-serif;
        color: var(--text-pri);
      }
      #label {
        font-weight: 600;
      }
      #bump {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--blue);
        background: var(--blue);
        color: #fff;
        font: inherit;
        cursor: pointer;
      }
      #count {
        min-width: 1.2em;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <span id="label"></span>
      <button id="bump" type="button">bump <span id="count">0</span></button>
    </div>
  `;
}

export namespace VerifyProbe {
  export interface Props {
    /** The chip's caption. */
    label: string;
    /** Starting counter value (0 for a fresh card). */
    start: number;
  }
}
