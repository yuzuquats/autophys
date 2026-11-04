import { Column, Div } from "../component-builtin";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { AnimatedPanel } from "./animated-panel";

type EventSummary = {
  title: string;
  when: string;
  where: string;
};

const EVENTS: EventSummary[] = [
  {
    title: "Design review",
    when: "Thu, Oct 15 · 2:00 – 3:00 PM",
    where: "Room 4B · Maya, Jonah and 4 others",
  },
  {
    title: "Quarterly planning",
    when: "Fri, Oct 16 · 10:00 AM – 12:30 PM",
    where: "Video call · 12 guests",
  },
  {
    title: "Dentist",
    when: "Mon, Oct 19 · 8:15 – 9:00 AM",
    where: "Mission St clinic",
  },
];

function makeEventCard(event: EventSummary): HTMLElement {
  const $card = Column.make();
  $card.assignStyles({ gap: "6px", padding: "16px 20px" });
  $card.append(
    Typography.h4(event.title),
    Typography.p(event.when),
    Typography.small(event.where),
  );
  return $card;
}

/** The panel is absolutely positioned and has no height of its own, so it
 * needs a positioned stage tall enough to hold the revealed card. */
function makeStage(heightPx: number): HTMLElement {
  const $stage = Div.make();
  $stage.assignStyles({
    position: "relative",
    height: `${heightPx}px`,
    "--popover-width": "min(320px, 100%)",
  });
  return Storybook.fill($stage, "360px");
}

export class CoreAnimatedPanelStoryBook extends Storybook.Default {
  title(): string {
    return "Animated Panel";
  }

  tags(): string[] {
    return ["std-animated-panel"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Revealed",
        render: () => {
          const $stage = makeStage(132);
          const $panel = AnimatedPanel.make();
          $stage.appendChild($panel);
          $panel.reveal(makeEventCard(EVENTS[0]));
          return $stage;
        },
      },
      {
        // Slides up on reveal and down on dismiss, then the next event.
        title: "Slide",
        render: () => {
          const $stage = makeStage(132);
          const $panel = AnimatedPanel.make();
          $stage.appendChild($panel);
          const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
          void (async () => {
            // Wait for the card to mount the stage before the first slide.
            for (let tries = 0; !$stage.isConnected; tries++) {
              if (tries >= 100) return;
              await wait(100);
            }
            for (let i = 0; $stage.isConnected; i = (i + 1) % EVENTS.length) {
              $panel.reveal(makeEventCard(EVENTS[i]));
              await wait(2200);
              if (!$stage.isConnected) return;
              await $panel.dismiss();
              await wait(600);
            }
          })();
          return $stage;
        },
      },
      {
        title: "Narrow",
        render: () => {
          const $stage = makeStage(72);
          $stage.style.setProperty("--popover-width", "220px");
          const $panel = AnimatedPanel.make();
          $stage.appendChild($panel);

          const $content = Column.make();
          $content.assignStyles({ gap: "4px", padding: "12px 16px" });
          $content.append(
            Typography.p("Copied link"),
            Typography.small("Anyone with the link can view"),
          );
          $panel.reveal($content);
          return $stage;
        },
      },
    ];
  }
}
