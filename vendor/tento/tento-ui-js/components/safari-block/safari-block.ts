import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { Session } from "../../session";
import { PageCard } from "../pages/page-card";

@component({
  name: "std-safari-block",
})
export class SafariBlock extends LonaWebComponent {
  private $card: PageCard = this.hydrate("card");

  constructor() {
    super();
    this.$card.bind({
      title: "Browser Not Supported",
      message:
        "Safari is not supported. Please use Chrome, Firefox, or Edge for the best experience.",
      secondary: {
        text: "Continue anyway",
        onClick: () => this.dismiss(),
      },
    });
  }

  dismiss(): void {
    this.remove();
  }

  static showIfSafari(
    isSafari: boolean = Session.isSafari,
  ): Option<SafariBlock> {
    if (!isSafari) return null;
    const $block = SafariBlock.make();
    document.body.appendChild($block);
    return $block;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 8000; /* ZIndex.BLOCKING */
        background: var(--bg);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #card {
        max-width: 360px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-page-card id="card"></std-page-card>
  `;
}
