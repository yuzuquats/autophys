import { Storybook } from "../../ui/storybook";
import { LandingIntegrations } from "./landing-integrations";

const integrations = [
  {
    name: "Google Calendar",
    logoUrl: "/@/static/img/integrations/google-calendar-64-icon.png",
  },
  {
    name: "Garmin",
    logoUrl: "/@/static/img/integrations/garmin-64-icon.svg",
  },
  {
    name: "Whoop",
    logoUrl: "/@/static/img/integrations/whoop.svg",
  },
  {
    name: "Claude",
    logoUrl: "/@/static/img/integrations/claude-64-icon.svg",
  },
  {
    name: "OpenAI",
    logoUrl: "/@/static/img/integrations/openai-64-icon.svg",
  },
  {
    name: "Gemini",
    logoUrl: "/@/static/img/integrations/gemini-64-icon.svg",
  },
];

function renderIntegrations(props: LandingIntegrations.Props): HTMLElement {
  const $frame = document.createElement("div");
  $frame.assignStyles({
    maxWidth: "960px",
    padding: "28px",
    background: "var(--bg)",
  });
  $frame.appendChild(LandingIntegrations.makeWith(props));
  return $frame;
}

export class LandingIntegrationsStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Integrations";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Logo name row",
        render: () => renderIntegrations({ integrations }),
      },
    ];
  }
}
