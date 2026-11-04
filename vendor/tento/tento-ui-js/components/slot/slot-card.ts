import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
@component({
  name: "std-slot-card",
})
export class SlotCard extends LonaWebComponent {
  bind(label: string, caption: string, isCurrent: boolean) {
    // Diffed: cards are rebound in place per header pass, and textContent
    // assignment replaces the text node even when the string is unchanged.
    const $label = this.$("label");
    if ($label.textContent !== label) $label.textContent = label;
    const $caption = this.$("caption");
    if ($caption.textContent !== caption) $caption.textContent = caption;
    const display = caption ? "block" : "none";
    if ($caption.style.display !== display) $caption.style.display = display;
    this.toggleAttribute("current", isCurrent);
  }

  flash() {
    this.toggleAttribute("flash", true);
    this.addEventListener(
      "animationend",
      () => {
        this.toggleAttribute("flash", false);
      },
      { once: true },
    );
  }

  static $blockStyle = css`
    .block {
      padding-block: var(--slot-card-padding-block, 4px);
      padding-inline: var(--slot-card-padding-inline, 8px);
      border-radius: 8px;
      border-top-left-radius: var(--slot-card-radius-top-left, var(--slot-card-radius, 8px));
      border-top-right-radius: var(--slot-card-radius-top-right, var(--slot-card-radius, 8px));
      border-bottom-right-radius: var(--slot-card-radius-bottom-right, var(--slot-card-radius, 8px));
      border-bottom-left-radius: var(--slot-card-radius-bottom-left, var(--slot-card-radius, 8px));
      max-width: 240px;
      cursor: pointer;
      position: relative;
      margin-block: var(--slot-card-margin-block, 2px);
      align-self: center;
      max-height: 40px;
      flex-grow: 1;
      align-items: center;
      justify-content: center;
    }

    .block::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: var(--bg-hover-light);
    }

    .block:hover::after {
      background: var(--bg-hover);
    }
  `;
  static $styles: Style.Compat[] = [
    SlotCard.$blockStyle,
    css`
      @keyframes header-flash {
        0% { background: transparent; }
        50% { background: var(--bg-hover); }
        100% { background: transparent; }
      }

      :host([flash]) #header {
        animation: header-flash 0.6s ease;
      }

      :host([current][flash]) #header {
        animation: none;
      }

      :host {
        width: 100%;
        display: flex;
        overflow: hidden;
        container-type: inline-size;
        flex-shrink: 0;
        --slot-card-height: var(--height);
      }

      :host([centered]) #header {
        align-items: center;
      }

      :host([small]) {
        --slot-card-height: calc(var(--height) - 2px);
      }

      :host([small]) .block {
        padding: 2px 2px;
        margin-inline: auto;
        width: 100%;
      }

      #header {
        flex-grow: 1;
        align-items: start;
        max-width: initial;
        margin-block: 0px;
        align-self: stretch;
        justify-content: center;
        gap: 8px;
      }

      :host([small]) #header {
        gap: 5px;
      }

      #root {
        height: var(--slot-card-height);
        max-width: unset;
        flex-grow: 1;
      }

      #label {
        color: var(--text-sec);
        --font-size: var(--text-10px);
      }

      :host([xs]) #label {
        --font-size: var(--text-7px);
      }

      #caption {
        --font-size: var(--text-7px);
        color: var(--text-ter);
      }

      :host([current]) #header {
        background: var(--fg-icon-pri-fill);
        color: white;
      }
      :host([current]) #caption,
      :host([current]) #label {
        color: white;
      }

      @container (width < 42px) {
        #label {
          --font-size: var(--text-9px);
        }
      }

      @container (width < 36px) {
        .block {
          padding: 0px;
        }

        .block::after {
          background: none;
        }

        :host([always-bg]) .block::after {
          background: var(--bg-hover-light);
        }
      }

      @container (width < 26px) {
        #label {
          --font-size: var(--text-8px);
        }

        #caption {
          --font-size: var(--text-7px);
        }
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <std-col id=header class=block>
        <p id=caption class=small></p>
        <p id=label></p>
      </std-col>
    </std-col>
  `;
}
