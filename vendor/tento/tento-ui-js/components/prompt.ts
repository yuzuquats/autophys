import "@tento-ui/components/round";

import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { GESTURE_MANAGER } from "../gesture-manager";
import { TaggedEnum } from "@tento-core/tagged-enum";
import { Button } from "./button/button";
import { Overlay } from "./overlay";
import { Round } from "./round";

@component({
  name: "std-prompt",
})
export class Prompt extends LonaWebComponent {
  $heroBg = this.hydrate<Round>("hero-bg")
    .bind({
      ...Round.Props.FLAT_CARD,
      bg: "var(--fg-icon-ter)",
      radius: 24,
    });
  $cta = this.$<HTMLButtonElement>("cta");

  bind(
    props: Prompt.Props & {
      onSubmit: () => void;
    },
  ): this {
    this.$("title").textContent = props.title;
    this.$("description").textContent = props.description;
    this.$("cta").textContent = props.completionText ?? "Continue";
    GESTURE_MANAGER.addPointerEvent(this.$cta, {
      onClick: () => props.onSubmit(),
    });
    return this;
  }

  static $styles: Style.Compat[] = [
    Button.$style,
    css`
      #hero {
        max-height: var(--hero-height, 320px);
        flex-basis: var(--hero-height, 320px);
        flex-grow: 1;
        margin: 2px;
        margin-bottom: 0px;
        position: relative;
      }

      #hero-bg {
        position: absolute;
        inset: 0;
        height: 100%;
        width: 100%;
      }

      #image {
        position: absolute;
        inset: 0;
        z-index: 1;
        display: grid;
        place-items: center;
        box-sizing: border-box;
        pointer-events: none;
      }

      #image::slotted(*) {
        width: 100%;
        height: 100%;
      }

      #text {
        padding: 20px;
        color: var(--text-sec);
      }

      #description {
        --line-height-ratio: 1.1;
        color: var(--text-ter);
        --margin-top: 12px;
      }

      #cta-row {
        border-top: 1px solid var(--divider);
        padding: 12px 20px;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-prompt-layout id=root>
      <div id=hero slot=hero>
        <std-round id=hero-bg></std-round>
        <slot id=image name=image></slot>
      </div>
      <std-col id=text slot=text>
        <h1 id=title class=h3></h1>
        <p id=description></p>
      </std-col>
      <std-row id=cta-row slot=text>
        <std-spacer></std-spacer>
        <button id=cta primary></button>
      </std-row>
    </std-prompt-layout>
  `;
}

export namespace Prompt {
  export type Props = {
    title: string;
    description: string;
    completionText?: Option<string>;
    cancelText?: Option<string>;
    type?: Option<"destructive" | "default">;
    autodismiss?: boolean;
  };

  export namespace Props {
    export function makeDelete(
      description: string,
      title?: Option<string>,
    ): Props {
      return {
        title: title ?? "Delete Confirmation",
        description,
        type: "destructive",
      };
    }
  }

  export namespace Completion {
    export type Enum = {
      completion: Prompt.Alert;
      cancel: Prompt.Alert;
    };
    export type Serialized = TaggedEnum<Enum>;
  }

  export async function show(
    props: Prompt.Props,
    overlay: Overlay = Overlay.instance.get(),
  ): Promise<Prompt.Completion> {
    return Prompt.Alert.show(props, overlay);
  }

  @component({
    name: "std-prompt-alert",
  })
  export class Alert extends LonaWebComponent {
    $bg = this.hydrate<Round>("bg")
      .bind({
        ...Round.Props.MODAL,
        bg: "var(--bg-elevated)",
      });

    private overlay: Option<Overlay>;

    static async show(
      props: Prompt.Props,
      overlay: Overlay = Overlay.instance.get(),
    ): Promise<Prompt.Completion> {
      const $alert = Alert.makeWith({
        ...props,
      });
      $alert.overlay = overlay;

      const autoDismissOnCompleteOrCancel = props.autodismiss ?? true;
      return new Promise((resolve) => {
        overlay.reveal($alert, {
          onDismiss: () => {
            resolve(Prompt.Completion.cancel($alert));
          },
          position: Overlay.Position.center(-100),
        });
        // Resolve the explicit outcome BEFORE `dismiss()`. `dismiss()` fires the
        // reveal-registered `onDismiss` (above → `resolve(cancel)`) on every
        // path, so calling it first would settle the promise as CANCEL and make
        // the later `resolve(completion)` a no-op — i.e. clicking Confirm would
        // return `didComplete() === false` and every confirm-prompt (delete a
        // sheet/row/task, settings actions, …) would silently no-op. A Promise
        // keeps its first resolution, so resolving here first wins; the
        // subsequent `dismiss()` still animates the alert out and its
        // `resolve(cancel)` is ignored. Backdrop/Escape (no button) still
        // resolve cancel via `onDismiss`.
        GESTURE_MANAGER.addPointerEvent($alert.$("completion-btn"), {
          onClick: () => {
            resolve(Prompt.Completion.completion($alert));
            if (autoDismissOnCompleteOrCancel) $alert.dismiss();
          },
        });
        GESTURE_MANAGER.addPointerEvent($alert.$("cancel-btn"), {
          onClick: () => {
            resolve(Prompt.Completion.cancel($alert));
            if (autoDismissOnCompleteOrCancel) $alert.dismiss();
          },
        });
      });
    }

    static makeWith(
      props: Prompt.Props &
        Optional<{
          onSubmit: () => void;
          onCancel: () => void;
        }>,
    ) {
      const $c = Prompt.Alert.make();
      $c.bind(props);
      return $c;
    }

    dismiss() {
      (this.overlay ?? Overlay.instance.get()).dismiss(this);
    }

    bind(
      props: Prompt.Props &
        Optional<{
          onSubmit: () => void;
          onCancel: () => void;
        }>,
    ): this {
      this.$("title").textContent = props.title;
      this.$("description").textContent = props.description;
      this.$("cancel-btn").textContent = props.cancelText ?? "Cancel";
      this.$("completion-btn").textContent = props.completionText ?? "Confirm";
      this.$("completion-btn").toggleAttribute(
        "primary",
        props.type == null || props.type === "default",
      );
      this.$("completion-btn").toggleAttribute(
        "destructive",
        props.type === "destructive",
      );
      GESTURE_MANAGER.addPointerEvent(this.$("completion-btn"), {
        onClick: () => props.onSubmit?.(),
      });
      GESTURE_MANAGER.addPointerEvent(this.$("cancel-btn"), {
        onClick: () => props.onCancel?.(),
      });
      return this;
    }

    static $styles = [
      Button.$style,
      css`
        :host {
          width: 100%;
          max-width: 360px;
        }

        #root {
          border-radius: 8px;
          position: relative;
        }

        h1 {
          --margin-top: 8px;
          --margin-bottom: 4px;
          color: var(--text-sec);
        }

        p {
          --margin-top: 8px;
          --margin-bottom: 8px;
          color: var(--text-ter);
        }

        #content {
          padding: 16px;
        }
      `,
    ];

    static $html = html`
      <std-col id="root">
        <std-round id=bg floating></std-round>
        <std-col id=content>
          <h1 id="title" class="h5"></h1>
          <p id="description"></p>
          <std-row style="margin-top:12px">
            <std-spacer></std-spacer>
            <button id="cancel-btn" secondary style="margin-right:8px"></button>
            <button id="completion-btn" primary></button>
          </std-row>
        </std-col>
      </std-col>
    `;
  }

  export class Completion extends TaggedEnum.Base<Completion.Enum> {
    static completion($prompt: Prompt.Alert): Completion {
      return new Completion({
        type: "completion",
        completion: $prompt,
      });
    }

    static cancel($prompt: Prompt.Alert): Completion {
      return new Completion({
        type: "cancel",
        cancel: $prompt,
      });
    }

    didComplete(): boolean {
      return this.internal.type === "completion";
    }
  }

  @component({
    name: "std-prompt-layout",
  })
  export class Layout extends LonaWebComponent {
    $bg = this.hydrate<Round>("bg")
      .bind({
        ...Round.Props.MODAL,
        bg: "var(--bg-elevated)",
        radius: 24,
      });

    static $styles: Style.Compat[] = [
      css`
        :host {
          display: block;
          max-height: 60vh;
          max-width: 360px;
          width: 100%;
        }

        :host([flat]) #bg {
          opacity: 0;
        }

        #root {
          height: 100%;
          width: 100%;
          position: relative;
        }

        #bg {
          z-index: 0;
        }

        #hero-container, #text-container {
          z-index: 1;
        }

        #text-container {
        }
      `,
    ];
    static $html: Option<HTMLTemplateElement> = html`
      <std-col id=root>
        <std-round id=bg floating></std-round>
        <slot name=hero></slot>
        <div id=text-container>
          <slot name=text></slot>
        </div>
      </std-col>
    `;
  }
}
