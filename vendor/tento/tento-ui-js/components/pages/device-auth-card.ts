import "../input/text-input";
import "./page-card";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { TextInput } from "../input/text-input";
import { PageCard } from "./page-card";

@component({ name: "std-device-auth-card" })
export class DeviceAuthCard extends LonaWebComponent {
  private $card: PageCard = this.hydrate("card");
  private $code: TextInput = this.hydrate("code");

  private value: string = "";
  private onApprove?: (code: string) => void;
  private onCodeChange?: (code: string) => void;

  constructor() {
    super();
    this.$code.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        this.onApprove?.(this.value.trim().toUpperCase());
      }
    });
  }

  bind(props: DeviceAuthCard.Props): this {
    if (props.initialCode != null) {
      this.value = props.initialCode;
    }
    this.onApprove = props.onApprove;
    this.onCodeChange = props.onCodeChange;

    const isDisabled = props.isBusy === true || props.isApproved === true;

    this.$code.bind({
      label: "Device Code",
      value: this.value,
      placeholder: "ABCD-EFGH",
      disabled: isDisabled,
      onChange: (value) => {
        this.value = value;
        this.onCodeChange?.(value);
      },
    });

    this.$card.bind({
      title: props.title ?? "Authorize Device",
      message:
        props.description ??
        "Enter the device code from your terminal to approve this login.",
      primary: {
        text: props.buttonText ?? "Approve Device",
        disabled: isDisabled,
        onClick: () => this.onApprove?.(this.value.trim().toUpperCase()),
      },
      status:
        props.statusMessage != null
          ? { text: props.statusMessage, variant: props.statusVariant }
          : null,
      footer:
        props.isApproved === true
          ? "Device approved. You can return to your terminal now."
          : null,
    });

    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      #card {
        width: 100%;
      }
    `,
  ];

  static $html = html`
    <std-page-card id="card">
      <std-text-input id="code"></std-text-input>
    </std-page-card>
  `;
}

export namespace DeviceAuthCard {
  export type StatusVariant = "default" | "error" | "success";

  export type Props = {
    title?: Option<string>;
    description?: Option<string>;
    initialCode?: Option<string>;
    buttonText?: Option<string>;
    statusMessage?: Option<string>;
    statusVariant?: Option<StatusVariant>;
    isBusy?: Option<boolean>;
    isApproved?: Option<boolean>;
    onApprove?: (code: string) => void;
    onCodeChange?: (code: string) => void;
  };
}
