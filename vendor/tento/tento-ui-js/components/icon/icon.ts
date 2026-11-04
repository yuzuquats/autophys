import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaIcons } from "../../ui/icons";

// One registered element that owns an icon's accessible name. `LonaIcons.make`
// is a helper that returns a styled div, and the thirteen `std-*-icon`
// components are pictures; none of them decides whether an icon is decorative
// or named. This one does, in `bind()`: no label means `aria-hidden`, a label
// means `role=img` with that name (rule R5). Size and colour are knobs; the
// colour's innermost fallback is `currentColor`, so an icon inherits from the
// text it sits beside unless told otherwise.
@component({ name: "std-icon" })
export class Icon extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  bind(props: Icon.Props): this {
    DomUtils.clearChildren(this.$root);
    this.$root.appendChild(LonaIcons.$svg(props.svg));
    if (props.label == null) {
      this.setAttribute("aria-hidden", "true");
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
    } else {
      this.removeAttribute("aria-hidden");
      this.setAttribute("role", "img");
      this.setAttribute("aria-label", props.label);
    }
    const size = props.size;
    if (size != null) this.style.setProperty("--icon-size", `${size}px`);
    else this.style.removeProperty("--icon-size");
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    DomUtils.clearChildren(this.$root);
    for (const a of ["aria-hidden", "role", "aria-label"]) this.removeAttribute(a);
  }

  static makeWith(props: Icon.Props): Icon {
    return Icon.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --icon-size: var(--icon-size-preset, 16px);
        --icon-color: var(--icon-color-preset, currentColor);

        display: inline-flex;
        flex: none;
        width: var(--icon-size);
        /* A stretching container (the storybook card among them) writes width
           on the host; the cap keeps an icon an icon. */
        max-width: var(--icon-size);
        height: var(--icon-size);
        color: var(--icon-color);
        vertical-align: middle;
      }

      #root {
        display: flex;
        width: 100%;
        height: 100%;
      }

      #root > svg {
        width: 100%;
        height: 100%;
        fill: currentColor;
      }
    `,
  ];

  static $html = html`<span id="root"></span>`;
}

export namespace Icon {
  export type Props = {
    svg: LonaIcons.RawSvg;
    /** The accessible name. `null` means decorative: hidden from the tree. */
    label: Option<string>;
    /** Pixels. `null` leaves the `--icon-size` knob to the caller's CSS. */
    size: Option<number>;
  };
}
