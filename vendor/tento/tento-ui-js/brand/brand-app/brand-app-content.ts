import { LonaWebComponent } from "../../component";
import { Column } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-brand-app-content" })
export class BrandAppContent extends LonaWebComponent {
  toPagelet(): HTMLElement {
    const $container = Column.make();
    while (this.firstElementChild) {
      $container.appendChild(this.firstElementChild);
    }
    return $container;
  }

  static $styles = [css`:host { display: none; }`];
}
