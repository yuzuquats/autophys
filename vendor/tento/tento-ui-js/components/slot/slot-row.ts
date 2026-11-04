import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import { SlotCard } from "./slot-card";

@component({
  name: "std-slot-row",
})
export class SlotRow extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private cards: SlotCard[] = [];

  bind(count: number, render: (index: number, $card: SlotCard) => void): this {
    while (this.cards.length > count) this.cards.pop()!.remove();
    while (this.cards.length < count) {
      const $card = SlotCard.make();
      $card.toggleAttribute("centered");
      $card.assignStyles({ flex: "1 1 0", minWidth: "0" });
      this.$container.appendChild($card);
      this.cards.push($card);
    }
    for (let i = 0; i < count; i++) {
      this.cards[i].style.visibility = "";
      render(i, this.cards[i]);
    }
    return this;
  }

  static $styles: Style.Compat[] = [css`
    :host { display: flex; width: 100%; }
    #container { display: flex; gap: 2px; flex: 1; min-width: 0; overflow: hidden; }
  `];
  static $html: Option<HTMLTemplateElement> = html`<std-row id="container"></std-row>`;
}
