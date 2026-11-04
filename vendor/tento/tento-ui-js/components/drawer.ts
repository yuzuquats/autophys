import "@tento-ui/components/mini-window";

import { MiniWindow } from "@tento-ui/components/mini-window";
import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { $$ } from "../fastdom";
import { SimpleKeyframe } from "../keyframe";
import { LazySync } from "../lazy";

@component({
  name: "std-drawer",
})
export class Drawer extends LonaWebComponent {
  $root: MiniWindow = this.hydrate("root");

  private static _instance = new LazySync(() => {
    const $drawer = Drawer.make();
    document.body.appendChild($drawer);
    return $drawer;
  });
  static get instance(): LazySync<Drawer> {
    return Drawer._instance;
  }

  constructor() {
    super();
    this.$root.onStateUpdate = (state) => {
      switch (state) {
        case "hidden":
          break;
        case "docked":
          this.$root.assignStyles({
            "--bg-width": "calc(100% + 12px)",
          });
          break;
        case "detached":
          this.$root.assignStyles({
            "--bg-width": "100%",
          });
          break;
      }
    };
  }

  toggleReveal(force: boolean = !this.hasAttribute("revealed")): boolean {
    const revealed = this.toggleAttribute("revealed", force);
    if (revealed) {
      this.reveal();
    } else {
      this.hide();
    }
    return revealed;
  }

  isRevealed(): boolean {
    return this.hasAttribute("revealed");
  }

  reveal(): void {
    this.toggleAttribute("revealed", true);
    $$.mutate(() => {
      this.$root.updateState("docked");
      this.$root.assignStyles({
        opacity: "0",
        // Grow-to-content: the window hugs its light-DOM content and owns the
        // cap. height:auto lets it shrink to short sheets; --mini-window-max-
        // height is the ceiling (viewport minus symmetric top/bottom margins);
        // --flow-max-height is the budget the inner flow-container/page get
        // (cap minus the nav bar), driving where the body starts to scroll.
        "--mini-window-height": "auto",
        "--mini-window-max-height": "calc(100vh - 2 * var(--p-margin-top))",
        "--flow-max-height":
          "calc(var(--mini-window-max-height) - var(--mini-window-nav-height, 0px))",
        "--docked-transform": "translate(calc(100vw), var(--p-margin-top))",
      });
      this.$root.setAnimates(false);
      $$.deferMutate(() => {
        this.$root.assignStyles({
          "--bg-width": "calc(100% + 12px)",
          "--docked-transform":
            "translate(calc(100vw - 100%), var(--p-margin-top))",
          opacity: "",
        });
        this.$root.setAnimates(true);
      });
    });
  }

  hide(): void {
    this.toggleAttribute("revealed", false);
    SimpleKeyframe.builder().animate(this.$root, true, 300);
    this.$root.updateState("docked");

    $$.mutate(() => {
      this.$root.assignStyles({
        transition: "",
        "--bg-width": "calc(100% + 12px)",
        "--docked-transform": "translate(calc(100vw), var(--p-margin-top))",
      });
    });
  }

  bind($child: HTMLElement, onClose?: () => void): void {
    this.$root.replaceChildren($child);
    this.$root.bind({
      minWidth: 400,
      // The drawer stays wherever it's dropped after a drag — no corner snap.
      snapToCorners: false,
      onClose,
    });
    this.reveal();
  }

  static $styles = [
    css`
      :host {
        --p-margin-top: var(--std-drawer-margin-top, 0px);
        z-index: 3500; /* ZIndex.DRAWER */
        top: 0px;
        position: absolute;
      }

      #root {
        --mini-window-detached-width: 480px;
        /* No fixed height — the drawer grows to content (reveal() sets
           --mini-window-height: auto + --mini-window-max-height). */
        --bg-width: calc(100% + 12px);
        /* The drawer's scroll lives in the inner #scroll (sheet-drawer-content),
           capped below --mini-window-max-height, so the mini-window #content
           never needs to scroll at rest. Leaving it overflow-y:auto makes it a
           redundant scroller that briefly shows a scrollbar during a grow: the
           grow-to-content page (position:absolute) overflows #content one frame
           before flow-container's remeasure() writes --p-height and #content's
           clientHeight catches up. hidden removes that transient scrollbar +
           layout shift (nothing is clipped at rest). */
        --mini-window-content-overflow-y: hidden;
        position: absolute;
      }
    `,
  ];
  static $html = html`
    <std-mini-window id="root"></std-mini-window>
  `;
}
