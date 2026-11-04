import "../../pill-text-input";

import { component } from "../../../component-decorators";
import { html, LonaWebComponent } from "../../../component";
import { PillTextInput } from "../../pill-text-input";
import { EventDetailsContent } from "../event-details-content";
import { css, Style } from "../../../component-styles";

@component({
  name: "std-add-participants-field",
})
export class AddParticipantsField extends LonaWebComponent {
  private $pillInput: PillTextInput = this.hydrate("pill-input");
  private emails: string[] = [];
  private onEmailsChange: Option<(emails: string[]) => void> = undefined;

  static makeWith(props?: AddParticipantsField.Props): AddParticipantsField {
    const $e = AddParticipantsField.make();
    $e.bind(props ?? {});
    return $e;
  }

  bind(props: AddParticipantsField.Props) {
    this.onEmailsChange = props.onEmailsChange;
    this.emails = props.initialEmails ?? [];
    const editable = props.editable ?? true;

    this.$pillInput.bind({
      placeholder: "Add participants (email addresses)...",
      validator: (text) => {
        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(text);
      },
      onChange: (pills) => {
        this.emails = pills;
        this.onEmailsChange?.(pills);
      },
      pills: this.emails,
      editable,
    });
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        width: 100%;
      }

      #pill-input {
        width: 100%;
        min-height: 36px;
        padding: 5px 8px;
        border-radius: 8px;
        background: transparent;
        --input-min-height: 0px;
        --input-pill-min-height: 26px;
        --input-pill-padding: 3px 6px 3px 8px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-pill-text-input id="pill-input"></std-pill-text-input>
  `;
}

export namespace AddParticipantsField {
  export type Props = Optional<{
    onEmailsChange: (emails: string[]) => void;
    initialEmails: string[];
    editable: boolean;
  }>;
}

export namespace EventDetailsFieldAddParticipants {
  export function make(): EventDetailsContent.Field<AddParticipantsField> {
    return EventDetailsContent.Field.makeWith(AddParticipantsField.makeWith(), {
      padding: "0px",
    });
  }
}

// @component({
//   name: "lona-participant",
// })
// export class Participant extends LonaWebComponent {
//   static makeWith(email: string): Participant {
//     const $e = Participant.make();
//     $e.bind(email);
//     return $e;
//   }

//   bind(email: string) {
//     this.appendChild(
//       Avatar.makeWithInitials(
//         Avatar.Props.fromUsername(email, { size: "16" }),
//       ).assignStyles({
//         marginRight: "6px",
//       }),
//     );
//     this.$("email").textContent = email;
//   }

//   static $styles: Style.Compat[] = [
//     css`
//       #root {
//         height: 28px;
//         width: 100%;
//         border-radius: 8px;
//         background: var(--bg-hover);
//         align-items: center;
//         padding-inline: 8px;
//         margin-top: 2px;
//       }
//     `,
//   ];
//   static $html: Option<HTMLTemplateElement> = html`
//     <std-row id="root">
//       <slot id="avatar"></slot>
//       <p id="email" class="small"></p>
//     </std-row>
//   `;
// }
