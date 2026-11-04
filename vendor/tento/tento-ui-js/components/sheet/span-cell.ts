import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { DomUtils } from "@tento-ui/dom";

@component({ name: "std-span-cell" })
export class SpanCell extends LonaWebComponent {
  private $pluginCell: Option<HTMLElement> = null;

  get pluginCell(): HTMLElement {
    return this.$pluginCell!;
  }

  bindContent($content: HTMLElement): void {
    this.$pluginCell = $content;
    DomUtils.clearChildren(this.$("root"));
    this.$("root").appendChild($content);
  }

  static $html = html`<div id="root"></div>`;
  static $styles = [css`
    :host {
      display: block;
      height: var(--height);
    }
    #root {
      position: relative;
      height: var(--height);
      overflow: hidden;
    }
  `];
}
