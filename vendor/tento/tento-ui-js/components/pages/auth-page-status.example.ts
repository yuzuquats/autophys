import { Storybook } from "@tento-ui/ui/storybook";
import { Div } from "../../component-builtin";
import { AuthPageStatus } from "./auth-page-status";

// A white auth-card surface holding the statuses, so the clean list-cell
// treatment reads (the storybook canvas is already a tinted surface). Mirrors
// the signin #status-list (a full-width, stretched column) so the preview
// matches production layout.
function card(...$statuses: AuthPageStatus[]): HTMLElement {
  const $card = Div.make();
  $card.assignStyles({
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "8px",
    width: "440px",
    padding: "16px",
    borderRadius: "16px",
    background: "var(--bg)",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.15)",
  });
  for (const $status of $statuses) $card.appendChild($status);
  return $card;
}

export class AuthPageStatusStoryBook extends Storybook.Default {
  title(): string {
    return "Auth Page Status";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Promo code ready (with code)",
        render: () =>
          card(
            AuthPageStatus.make().bind({
              variant: "promo",
              message: "Promo code ready to apply",
              code: "FREEYEAR",
            }),
          ),
      },
      {
        title: "Promo status",
        render: () =>
          card(
            AuthPageStatus.make().bind({
              variant: "promo",
              message: "Google Calendar connected",
              code: null,
            }),
          ),
      },
      {
        title: "Error status",
        render: () =>
          card(
            AuthPageStatus.make().bind({
              variant: "error",
              message: "Invalid promo code",
              code: null,
            }),
          ),
      },
      {
        title: "Onboarding statuses (list)",
        render: () =>
          card(
            AuthPageStatus.make().bind({
              variant: "promo",
              message: "Promo code ready to apply",
              code: "WELCOME25",
            }),
            AuthPageStatus.make().bind({
              variant: "promo",
              message: "Google Calendar connected",
              code: null,
            }),
            AuthPageStatus.make().bind({
              variant: "promo",
              message: "Google Drive connected",
              code: null,
            }),
            AuthPageStatus.make().bind({
              variant: "error",
              message: "Missing required scopes for Google Tasks",
              code: null,
            }),
          ),
      },
    ];
  }
}
