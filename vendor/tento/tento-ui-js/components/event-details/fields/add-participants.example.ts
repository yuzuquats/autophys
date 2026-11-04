import { Storybook } from "../../../ui/storybook";
import { AddParticipantsField } from "./add-participants";

export class AddParticipantsFieldStoryBook extends Storybook.Default {
  title(): string {
    return "Add Participants Field";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default (Editable)",
        render: () => {
          return AddParticipantsField.makeWith({
            initialEmails: ["alice@example.com", "bob@example.com"],
            onEmailsChange: (emails) => {
              console.log("Emails changed:", emails);
            },
          });
        },
      },
      {
        title: "Disabled (Read-only)",
        render: () => {
          return AddParticipantsField.makeWith({
            initialEmails: ["alice@example.com", "bob@example.com"],
            editable: false,
          });
        },
      },
    ];
  }
}
