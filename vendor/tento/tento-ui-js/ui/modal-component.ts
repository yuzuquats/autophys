import { LonaWebComponent } from "../component";
import { css } from "../component-styles";
import { Overlay } from "../components/overlay";
import { LazySync } from "../lazy";

export class LonaModalWebComponent extends LonaWebComponent {
  $childOverlay = new LazySync(() => new Overlay(document.body, "0px"));
  onModalDismiss() {}

  reveal(
    $overlay: Overlay = Overlay.instance.get(),
    context: Option<string> = null,
    position: Option<Overlay.Position> = null,
  ) {
    $overlay.reveal(this, {
      onDismiss: () => this.onModalDismiss(),
      position,
    });
    $overlay.setContext(context);
  }

  dismiss($overlay: Overlay = Overlay.instance.get()) {
    $overlay.dismiss(this);
  }

  toggle($overlay: Overlay = Overlay.instance.get()) {
    if ($overlay.isRevealed(this)) {
      this.dismiss();
    } else {
      this.reveal();
    }
  }

  static $headerStyle = css`
    .modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--divider);
    }

    .modal-title {
      --margin-top: 0px;
      --margin-bottom: 0px;
    }
  `;
  static $style = css`
    :host {
      width: 100%;
      max-width: var(--std-modal-max-width, 780px);
      --std-modal-max-height: calc(100vh - 40px);
    }

    #root {
      height: 100%;
      max-height: var(--std-modal-max-height);
    }
  `;
  static $styles = [LonaModalWebComponent.$style];
}
