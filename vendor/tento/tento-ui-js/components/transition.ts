import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { Style, css } from "../component-styles";
import { $$ } from "../fastdom";

@component({
  name: "std-transition",
})
export class Transition<
  Before extends HTMLElement = HTMLElement,
  After extends HTMLElement = HTMLElement,
> extends LonaWebComponent {
  private state: Option<Transition.State>;
  private callbacks?: Option<Transition.Callbacks<Before, After>>;

  onSizeChange: Option<(s: Size) => void> = (s) => {
    if (this.getAttribute("height") !== "fill") return;
    const h = s.height + "px";
    this.$("before-container").style.height = h;
    this.$("after-container").style.height = h;
    for (const $el of this.$<HTMLSlotElement>("before").assignedElements()) {
      ($el as HTMLElement).style.height = h;
    }
    for (const $el of this.$<HTMLSlotElement>("after").assignedElements()) {
      ($el as HTMLElement).style.height = h;
    }
  };

  get $before(): Option<Before> {
    return this.$<HTMLSlotElement>("before").assignedElements()[0] as Option<Before>;
  }

  get $after(): Option<After> {
    return this.$<HTMLSlotElement>("after").assignedElements()[0] as Option<After>;
  }

  bind(props: Transition.Props<Before, After>): this {
    this.callbacks = props.callbacks;
    props.$before.slot = "before";
    this.appendChild(props.$before);

    props.$after.slot = "after";
    this.appendChild(props.$after);

    this.bindState(props.state);

    return this;
  }

  bindState(to: Transition.State) {
    this.state = to;
    if (to === "before") {
      this.callbacks?.onTransitionBefore?.(this.$before);
    } else {
      this.callbacks?.onTransitionAfter?.(this.$after);
    }

    const $before = this.$("before-container");
    const $after = this.$("after-container");
    const [$revealed, $hidden] =
      to === "before" ? [$before, $after] : [$after, $before];

    $$.mutate(() => {
      $revealed.toggleAttribute("revealed", true);
      $hidden.toggleAttribute("revealed", false);
    });
  }

  toggleState() {
    this.bindState(this.state === "before" ? "after" : "before");
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
      }

      #root {
        height: 100%;
        width: 100%;
      }

      #transition-container {
        display: grid;
        min-height: 100%;
      }

      .container {
        grid-area: 1 / 1;
        min-height: 0;
        transition: var(--transition, opacity 0.3s ease);
        opacity: 0;
        pointer-events: none;
      }

      slot::slotted(*) {
        pointer-events: none;
      }

      .container[revealed] {
        opacity: 1;
      }

      .container[revealed] slot::slotted(*) {
        pointer-events: all;
      }

      .container:not([revealed]) slot::slotted(*) {
        cursor: none;
      }

      :host([height="fill"]) {
        flex: 1;
        min-height: 0;
      }

      :host([height="fill"]) #transition-container {
        position: relative;
        height: 100%;
      }

      :host([height="fill"]) .container {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        overflow: auto;
      }
    `,
  ];
  static $html = html`
    <std-col id="root">
      <div id="transition-container">
        <std-col id="before-container" class="container">
          <slot id="before" name="before"></slot>
        </std-col>
        <std-col id="after-container" class="container">
          <slot id="after" name="after"></slot>
        </std-col>
      </div>
    </std-col>
  `;
}

export namespace Transition {
  export type State = "before" | "after";
  export type Callbacks<
    Before extends HTMLElement,
    After extends HTMLElement,
  > = Optional<{
    onTransitionBefore: ($e: Option<Before>) => void;
    onTransitionAfter: ($e: Option<After>) => void;
  }>;

  export type Props<Before extends HTMLElement, After extends HTMLElement> = {
    state: State;
    callbacks?: Option<Callbacks<Before, After>>;
    $before: Before;
    $after: After;
  };
}
