import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";

@component({
  name: "std-button",
})
export class Button extends LonaWebComponent {
  static get observedAttributes() {
    return [
      "primary",
      "secondary",
      "destructive",
      "flat",
      "disabled",
      "thin",
      "selected",
    ];
  }

  private $root: HTMLButtonElement = this.$("root");

  attributeChangedCallback(
    name: string,
    _old: string | null,
    value: string | null,
  ) {
    this.$root.toggleAttribute(name, value !== null);
  }

  // Pooled instances are reused via `make()`. `makeWith` writes the variant
  // (primary/secondary/destructive/flat) straight onto `#root`, and callers
  // toggle modifiers (thin/disabled/selected) on the host — so without an
  // explicit reset a recycled button keeps its prior life's attributes. That's
  // how a recycled `flat` button reused as `primary` ends up `primary flat`:
  // `flat`'s `--fg-btn: var(--text-ter)` (declared after `[primary]`) then wins
  // over primary's white text, rendering gray text on the primary fill. Clear
  // both surfaces on recycle.
  onRecycle(): void {
    for (const name of Button.observedAttributes) {
      this.removeAttribute(name);
      this.$root.removeAttribute(name);
    }
  }

  static makeWith(
    $content: HTMLElement | string,
    props: Optional<{
      type: "flat" | "primary" | "secondary" | "destructive";
      onClick: EmptyFunction;
    }>,
  ): Button {
    const $b = Button.make();
    if ($content instanceof HTMLElement) {
      $b.appendChild($content);
    } else {
      $b.textContent = $content;
    }
    props.type && $b.$("root").toggleAttribute(props.type, true);
    props.onClick &&
      GESTURE_MANAGER.addPointerEvent($b, {
        onClick: props.onClick,
      });
    return $b;
  }

  static style = /* css */ `
    .button,
    button {
      --font-size: var(--p-size);

      /* The UA stylesheet sets a FAMILY on form controls (Chrome:
         'button { font: 400 13.333px Arial }'), and a UA declaration on the
         button beats anything inherited from its container — so without this
         line a button never wears the page's face, whatever the page sets.
         Every sibling control in this library already does it: input-styles,
         select-input, pill-select, code-input, button-group-row. This one had
         been the exception, which is why a page could be set to one family and
         still render every button in Arial. Size is NOT reset here: callers
         and containers set it deliberately. */
      font-family: inherit;

      border: none;
      background: var(--bg-btn, none);
      color: var(--fg-btn, inherit);
      cursor: pointer;
      /* Overridable per-corner for composed shapes (a split button's inner
         seam); the default is the shape every existing button has. */
      border-radius: var(--button-radius, 8px);
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: center;
      user-select: none;
      text-decoration: none;
      transition: background-color 0.15s ease;

      white-space: nowrap;
      text-overflow: ellipsis;

      padding: var(--button-padding, 8px 12px);
    }
    .button:focus,
    button:focus {
      outline: none;
    }
    .button:focus-visible,
    button:focus-visible {
      outline: 2px solid var(--blue);
      outline-offset: 2px;
    }
    .button:hover,
    button:hover {
      color: var(--fg-btn-hvr, var(--fg-btn));
      background: var(--bg-btn-hvr, var(--bg-hover));
    }
    .button[selected],
    button[selected] {
      --bg-btn: var(--bg-selected);
    }

    button[primary],
    .button[primary] {
      --fg-btn: var(--fg-btn-pri);
      --bg-btn: var(--bg-btn-pri);
      --bg-btn-hvr: var(--bg-btn-pri-hover);
    }

    button[secondary],
    .button[secondary] {
      --fg-btn: var(--fg-btn-sec);
      --bg-btn: var(--bg-btn-sec);
      --fg-btn-hvr: var(--text-pri);
      --bg-btn-hvr: var(--bg-btn-sec-hover);
    }

    button[flat],
    .button[flat] {
      --fg-btn: var(--text-ter);
      text-decoration: none;
      --bg-btn-hvr: var(--bg-hover);
    }

    button[destructive],
    .button[destructive] {
      --fg-btn: var(--fg-btn-destructive);
      --bg-btn: var(--bg-btn-destructive);
      --bg-btn-hvr: var(--bg-btn-destructive);
    }

    button[disabled],
    .button[disabled] {
      --fg-btn: var(--bg);
      --bg-btn: var(--bg-selected);
      --bg-btn-hvr: var(--bg-selected);
      cursor: default;
    }

    button[thin],
    .button[thin] {
      padding: 4px 12px;
    }
  `;

  static $style = css(Button.style);
  static $styles = [
    Button.$style,
    css`
      :host {
        --button-padding: 8px 12px;
      }
      #root {
        width: 100%;
        height: 100%;
        /* The native <button> in this shadow root takes the browser's control
           face (Arial) unless told otherwise; the page's reset never reaches
           in here. The label takes the face of wherever the button sits. */
        font-family: inherit;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <button id=root><slot></slot></button>
  `;
}

export namespace Button {
  export const makeLight = () => document.createElement("button");

  export function makeWithLight(
    $content: HTMLElement | string,
    props: Optional<{
      type: "flat" | "primary" | "secondary" | "destructive";
      onClick: EmptyFunction;
      size: "thin";
    }>,
  ): HTMLButtonElement {
    const $button = Button.makeLight();
    if ($content instanceof HTMLElement) {
      $button.appendChild($content);
    } else {
      $button.textContent = $content;
    }
    props.type && $button.toggleAttribute(props.type, true);
    props.onClick &&
      GESTURE_MANAGER.addPointerEvent($button, {
        onClick: props.onClick,
      });
    $button.toggleAttribute("thin", props.size === "thin");
    return $button;
  }
}
