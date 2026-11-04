// Storybook-only convolution-kernel gallery: a HeroLayout grid of `KernelPreview` curve tiles
// (gaussian / hamming / epanechnikov / boxcar) with a selection + description panel. The kernel
// math is owned by @tento-core (re-exported via ./kernels) — this is the UI/reference only, with
// no production consumer; kept as a tuning reference for the convolution/blur work.
import "../components/hero-layout/hero-layout";
import "../components/button/button";
import "./kernel-preview";
import "../components/round";

import { component } from "../component-decorators";
import { css } from "../component-styles";
import { html, LonaWebComponent } from "../component";
import { HeroLayout } from "../components/hero-layout/hero-layout";
import { KernelPreview } from "./kernel-preview";
import { DomUtils } from "../dom";
import { Button } from "../components/button/button";
import { Round } from "../components/round";

@component({
  name: "std-kernel-picker",
})
export class KernelPicker extends LonaWebComponent {
  $bg = this.hydrate<Round>("bg")
    .bind({
      ...Round.Props.FLAT_CARD,
      bg: "var(--bg-hover)",
    });
  private $heroLayout: HeroLayout = this.hydrate("hero-layout");

  $statusBarContainer = this.hydrate<Round>("status-bar-bg")
    .bind({
      ...Round.Props.FLAT_CARD,
      bg: "var(--bg)",
    });
  private $title: HTMLElement = this.$("title");
  private $description: HTMLElement = this.$("description");

  private showNavBar: boolean = false;

  private currentProps: Option<KernelPicker.Props>;
  private $changeButton: Option<Button>;
  private hoveredIndex: Option<number>;

  private getChangeButton(): Button {
    if (!this.$changeButton) {
      this.$changeButton = Button.makeWith("Change", {
        type: "secondary",
        onClick: () => {
          this.showNavBar = !this.showNavBar;
          this.updateHeroLayout();
        },
      });
      this.$changeButton.slot = "controls";
    }
    return this.$changeButton;
  }

  private handleHover = (index: Option<number>): void => {
    this.hoveredIndex = index;
    this.updateTitle();
  };

  private updateHeroLayout(): void {
    if (!this.currentProps) return;
    this.$heroLayout.bind({
      selectedIndex: this.currentProps.selectedIndex ?? 0,
      previewSize: { width: 80, height: 60 },
      showNavBar: this.showNavBar,
      onChange: this.currentProps.onChange,
      onHover: this.handleHover,
    });
    this.updateTitle();
  }

  private updateTitle(): void {
    const displayIndex =
      this.hoveredIndex ?? this.currentProps?.selectedIndex ?? 0;
    const item = this.currentProps?.items[displayIndex];
    this.$title.textContent = item?.title ?? "";
    this.$description.textContent = item?.description ?? "";
  }

  bind(props: KernelPicker.Props): this {
    this.currentProps = props;
    this.hoveredIndex = undefined;
    DomUtils.clearChildren(this.$heroLayout, false);

    for (const previewProps of props.items) {
      const $item = HeroLayout.Item.makeWith({
        borderRadius: 12,
        isStatic: false,
      });

      const $preview = KernelPreview.make();
      $preview.bind(previewProps);
      $item.appendChild($preview);

      this.$heroLayout.appendChild($item);
    }

    this.$heroLayout.appendChild(this.getChangeButton());
    this.updateHeroLayout();

    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      #title {
      }

      #hero-container {
        position: relative;
        margin-top: 4px;
      }

      #hero-layout {
        width: 100%;
        height: 100%;
      }

      #status-bar-bg {
        height: auto;
      }

      #status-bar {
        gap: 6px;
        padding: 16px 20px;
      }

      #description {
        color: var(--text-ter);
      }
    `,
  ];

  static $html = html`
    <std-round id=status-bar-bg>
      <std-col id=status-bar>
        <h5 id="title"></h4>
        <p id="description"></p>
      </std-col>
    </std-round>
    <div id=hero-container>
      <std-round floating id=bg></std-round>
      <std-hero-layout id="hero-layout"></std-hero-layout>
    </div>
  `;
}

export namespace KernelPicker {
  export type Props = {
    items: KernelPreview.Props[];
    selectedIndex?: number;
    onChange?: (index: number) => void;
  };
}
