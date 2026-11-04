import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { LandingStickerPlayground } from "./landing-sticker-playground";

function renderPlayground(): HTMLElement {
  const $frame = document.createElement("div");
  $frame.dataset.pageEngineRoot = "true";
  $frame.assignStyles({
    position: "relative",
    maxWidth: "1080px",
    minHeight: "760px",
    padding: "28px",
    background: "var(--bg)",
    border: "1px solid var(--divider)",
    overflow: "visible",
  });

  const $intro = document.createElement("section");
  $intro.assignStyles({
    display: "grid",
    gap: "14px",
    padding: "44px 24px",
    borderBottom: "1px solid var(--divider)",
  });
  const $title = Typography.h2("Landing sticker playground");
  const $copy = Typography.p(
    "Drag stickers from the sheet and drop them anywhere on this page surface.",
  );
  $copy.style.color = "var(--text-sec)";
  $intro.append($title, $copy);

  const $playground = LandingStickerPlayground.make();
  const $playgroundSection = document.createElement("section");
  $playgroundSection.assignStyles({
    padding: "36px 24px",
    borderBottom: "1px solid var(--divider)",
  });
  $playgroundSection.appendChild($playground);

  const $content = document.createElement("section");
  $content.assignStyles({
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "16px",
    padding: "36px 24px 120px",
  });
  for (const label of ["Hero copy", "Feature grid", "Final CTA"]) {
    const $card = document.createElement("article");
    $card.assignStyles({
      minHeight: "150px",
      padding: "18px",
      border: "1px solid var(--divider)",
      borderRadius: "8px",
      background: "color-mix(in srgb, var(--bg) 92%, var(--yellow) 8%)",
    });
    $card.appendChild(Typography.h3(label));
    $content.appendChild($card);
  }

  $frame.append($intro, $playgroundSection, $content);
  $playground.bind({});
  return $frame;
}

export class LandingStickerPlaygroundStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Sticker Playground";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () => renderPlayground(),
      },
    ];
  }
}
