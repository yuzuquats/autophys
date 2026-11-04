import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// A row of controls that is one tab stop. `std-menu-bar` is the action row and,
// by its own comment, declines `role=toolbar` and arrow navigation. This is the
// WAI toolbar: `role=toolbar aria-orientation`, and on `slotchange` it
// collects the focusable slotted controls and applies a roving tabindex with
// Arrow/Home/End — so the whole row is one Tab stop, and Tab leaves it.
// Controls stay in the caller's light DOM under the caller's stylesheet.
@component({ name: "std-toolbar" })
export class Toolbar extends LonaWebComponent {
  private $slot: HTMLSlotElement = this.$("slot");
  private props: Option<Toolbar.Props>;
  private $controls: HTMLElement[] = [];
  private focused = 0;

  constructor() {
    super();
    this.$slot.addEventListener("slotchange", () => this.rove());
    this.addEventListener("keydown", this.onKeydown);
    this.addEventListener("focusin", (e) => {
      const $control = e.composedPath().find(
        ($node) => $node instanceof HTMLElement && this.$controls.includes($node),
      );
      if (!($control instanceof HTMLElement)) return;
      this.focused = this.$controls.indexOf($control);
      this.rove();
    });
  }

  bind(props: Toolbar.Props): this {
    this.props = props;
    this.setAttribute("role", "toolbar");
    this.setAttribute("aria-label", props.label);
    this.setAttribute("aria-orientation", props.orientation);
    this.toggleAttribute("vertical", props.orientation === "vertical");
    this.rove();
    return this;
  }

  /** The focusable node of a slotted control: the native button inside a
   * `std-button`-like host, else the host itself. */
  private static focusTarget($el: HTMLElement): HTMLElement {
    return $el.shadowRoot?.querySelector<HTMLElement>("button, [href], input, [tabindex]") ?? $el;
  }

  private rove(): void {
    const slotted = this.$slot.assignedElements({ flatten: true }) as HTMLElement[];
    this.$controls = slotted.filter(($el) => !$el.hasAttribute("disabled") && !$el.hasAttribute("hidden"));
    this.focused = Math.min(this.focused, Math.max(0, this.$controls.length - 1));
    this.$controls.forEach(($el, i) => {
      Toolbar.focusTarget($el).tabIndex = i === this.focused ? 0 : -1;
    });
  }

  private onKeydown = (e: KeyboardEvent): void => {
    const props = this.props;
    const n = this.$controls.length;
    if (props == null || n === 0) return;
    const horizontal = props.orientation === "horizontal";
    const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
    const prevKey = horizontal ? "ArrowLeft" : "ArrowUp";
    let next: Option<number> = null;
    if (e.key === nextKey) next = (this.focused + 1) % n;
    else if (e.key === prevKey) next = (this.focused - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next == null) return;
    e.preventDefault();
    this.focused = next;
    this.rove();
    Toolbar.focusTarget(this.$controls[next]).focus();
  };

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$controls = [];
    this.focused = 0;
    for (const a of ["role", "aria-label", "aria-orientation", "vertical"]) this.removeAttribute(a);
  }

  static makeWith(props: Toolbar.Props): Toolbar {
    return Toolbar.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --toolbar-gap: var(--toolbar-gap-preset, 8px);
        --toolbar-padding: var(--toolbar-padding-preset, 4px);
        --toolbar-min-height: 0px;

        display: flex;
        align-items: center;
        gap: var(--toolbar-gap);
        padding: var(--toolbar-padding);
        min-height: var(--toolbar-min-height);
        width: 100%;
        box-sizing: border-box;
      }

      :host([vertical]) {
        flex-direction: column;
        align-items: stretch;
        width: auto;
      }
    `,
  ];

  static $html = html`<slot id="slot"></slot>`;
}

export namespace Toolbar {
  export type Props = {
    /** The toolbar's accessible name. */
    label: string;
    orientation: "horizontal" | "vertical";
  };
}
