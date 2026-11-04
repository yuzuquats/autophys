import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";

// One of N, on a track, with the radio keyboard. `std-pill-select` binds
// positionally, is a `radiogroup` without arrow keys, and is a row of pills
// rather than a track; `std-split-buttons` is three fixed buttons. This is the
// WAI radio pattern on a track: `role=radiogroup`, each option `role=radio`
// with `aria-checked`, ONE tab stop (the checked option) and arrows that move
// the selection, and a thumb that slides under the chosen option — the slide
// is a transform transition, off under reduced motion.
@component({ name: "std-segmented-control" })
export class SegmentedControl extends LonaWebComponent {
  private $track: HTMLElement = this.$("track");
  private $thumb: HTMLElement = this.$("thumb");
  private props: Option<SegmentedControl.Props>;
  private $options: HTMLButtonElement[] = [];

  constructor() {
    super();
    // Own shadow node, once: the handlers read the live props.
    this.$track.addEventListener("keydown", this.onKeydown);
    this.$track.addEventListener("click", this.onClick);
  }

  bind(props: SegmentedControl.Props): this {
    this.props = props;
    this.setAttribute("role", "radiogroup");
    this.setAttribute("aria-label", props.label);
    // A caller rebinds on change; the option under focus is about to be
    // rebuilt, so remember which one it was and put focus back on its
    // successor. Without this, arrowing through the control drops focus to
    // the body on every step.
    const $focused = this.shadowRoot?.activeElement as Option<HTMLElement>;
    const focusedId = $focused?.closest<HTMLElement>("button.option")?.dataset.id ?? null;
    DomUtils.clearChildren(this.$track);
    this.$track.appendChild(this.$thumb);
    this.$options = props.options.map((o, i) => {
      const $b = document.createElement("button");
      $b.type = "button";
      $b.className = "option";
      $b.dataset.id = o.id;
      $b.dataset.index = String(i);
      $b.setAttribute("role", "radio");
      if (o.icon != null) {
        const $svg = LonaIcons.$svg(o.icon);
        $svg.setAttribute("aria-hidden", "true");
        $b.appendChild($svg);
      }
      const $label = Typography.small(o.label);
      $label.className = "label";
      $b.appendChild($label);
      this.$track.appendChild($b);
      return $b;
    });
    this.reflect(props.value);
    if (focusedId != null) this.$options.find(($b) => $b.dataset.id === focusedId)?.focus();
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // The thumb is placed from offsetWidth/offsetLeft, and both are 0 while the
    // element is out of the document — so a control built with `makeWith` and
    // appended afterwards (the natural order, and what makeWith is for) came up
    // with its thumb sized to nothing and no option looking chosen. Place it
    // again the moment there is a box to measure.
    const props = this.props;
    if (props != null) this.reflect(props.value);
  }

  private reflect(value: string): void {
    let checkedIndex = -1;
    this.$options.forEach(($b, i) => {
      const checked = $b.dataset.id === value;
      if (checked) checkedIndex = i;
      $b.setAttribute("aria-checked", checked ? "true" : "false");
      $b.tabIndex = checked ? 0 : -1;
      $b.toggleAttribute("checked", checked);
    });
    // The roving tab stop needs one stop even when nothing is checked yet.
    if (checkedIndex < 0 && this.$options.length > 0) this.$options[0].tabIndex = 0;
    this.moveThumb(checkedIndex);
  }

  private moveThumb(index: number): void {
    if (index < 0) {
      this.$thumb.style.opacity = "0";
      return;
    }
    const $b = this.$options[index];
    this.$thumb.style.opacity = "1";
    this.$thumb.style.width = `${$b.offsetWidth}px`;
    this.$thumb.style.transform = `translateX(${$b.offsetLeft}px)`;
  }

  private choose(index: number, focus: boolean): void {
    const props = this.props;
    const $b = this.$options[index];
    if (props == null || $b == null) return;
    const id = $b.dataset.id ?? "";
    if (focus) $b.focus();
    if (id === props.value) return;
    this.reflect(id);
    props.onChange(id);
  }

  private onClick = (e: MouseEvent): void => {
    const $b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.option");
    if ($b == null) return;
    this.choose(Number($b.dataset.index), true);
  };

  private onKeydown = (e: KeyboardEvent): void => {
    const $b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.option");
    if ($b == null) return;
    const i = Number($b.dataset.index);
    const n = this.$options.length;
    let next: Option<number> = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (i + 1) % n;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (i - 1 + n) % n;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      case " ":
      case "Enter":
        next = i;
        break;
    }
    if (next == null) return;
    e.preventDefault();
    this.choose(next, true);
  };

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$options = [];
    DomUtils.clearChildren(this.$track);
    this.$track.appendChild(this.$thumb);
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: SegmentedControl.Props): SegmentedControl {
    return SegmentedControl.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --segmented-bg: var(--segmented-bg-preset, var(--bg-surface-light));
        --segmented-thumb-bg: var(--segmented-thumb-bg-preset, var(--bg));
        --segmented-color: var(--text-sec);
        --segmented-color-checked: var(--text-pri);
        --segmented-radius: 8px;
        --segmented-padding: 3px;

        display: inline-block;
        max-width: max-content;
      }

      #track {
        position: relative;
        display: inline-flex;
        padding: var(--segmented-padding);
        border-radius: var(--segmented-radius);
        background: var(--segmented-bg);
      }

      #thumb {
        position: absolute;
        top: var(--segmented-padding);
        bottom: var(--segmented-padding);
        left: 0;
        width: 0;
        border-radius: calc(var(--segmented-radius) - 2px);
        background: var(--segmented-thumb-bg);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
        transition: transform 0.18s ease, width 0.18s ease, opacity 0.18s ease;
        pointer-events: none;
      }

      .option {
        position: relative;
        z-index: 1;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        padding: 0 12px;
        margin: 0;
        border: 0;
        border-radius: calc(var(--segmented-radius) - 2px);
        background: transparent;
        color: var(--segmented-color);
        font-family: inherit;
        cursor: pointer;
      }

      .option[checked] {
        color: var(--segmented-color-checked);
      }

      .option:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 1px;
      }

      .option > svg {
        width: 14px;
        height: 14px;
        fill: currentColor;
      }

      .label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: inherit;
      }

      @media (prefers-reduced-motion: reduce) {
        #thumb {
          transition: none;
        }
      }
    `,
  ];

  static $html = html`<div id="track"><div id="thumb"></div></div>`;
}

export namespace SegmentedControl {
  export type Option_ = { id: string; label: string; icon: Option<LonaIcons.RawSvg> };
  export type Props = {
    options: Option_[];
    value: string;
    onChange: (id: string) => void;
    /** The group's accessible name. */
    label: string;
  };
}
