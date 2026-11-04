import { Constants } from "@tento-core/constants";
import { NaiveDate } from "@tento-chrono";

import { AllCompleteState } from "../../components/home-card/all-complete-state";
import { HomeGridCard } from "../../components/home-card/home-grid-card";
import { SheetRowNumberCard } from "../../components/home-card/number-card";
import { RowIcon } from "../../components/home-card/row-icon";
import { SheetRowTextCard } from "../../components/home-card/text-card";
import {
  CalendarIcon,
  LonaIcons,
  MoonIcon,
  NumberIcon,
  TextIcon,
} from "../../ui/icons";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";

import { FeatureCardContent } from "./feature-card-hero-library/content";
import { FeatureCardHeroImagePlaceholder } from "./feature-card-hero-image-placeholder";

const SPOTLIGHT_PLACEHOLDER: FeatureCardHeroImagePlaceholder.PlaceholderSpec = {
  id: "spotlight",
  label: "Spotlight 600 x 400",
  layout: "contain-center",
  fill: "#d6efcf",
  textColor: "#20371b",
};

type ContentCandidate = {
  label: string;
  placeholder: FeatureCardHeroImagePlaceholder.PlaceholderSpec;
  $render: () => HTMLElement;
};

type FrameSpec = {
  label: string;
  $content: HTMLElement;
  width: string;
  height: string;
};

const CONTENT_CANDIDATES: ContentCandidate[] = [
  {
    label: "image / calendar",
    placeholder: {
      id: "image-calendar",
      label: "Calendar 1200 x 675",
      layout: "cover-center",
      fill: "#d7e8ff",
      textColor: "#17283d",
    },
    $render: () =>
      $imageContent("/@/static/img/landing/cal-calendar.jpg", "Calendar"),
  },
  {
    label: "image / tasks sidebar",
    placeholder: {
      id: "image-tasks",
      label: "Tasks 1200 x 675",
      layout: "cover-center",
      fill: "#fff0bf",
      textColor: "#3a2a09",
    },
    $render: () =>
      $imageContent("/@/static/img/landing/cal-tasks-sidebar.jpg", "Tasks"),
  },
  {
    label: "home cards / stack",
    placeholder: {
      id: "home-card-stack",
      label: "Home cards 1200 x 675",
      layout: "contain-center",
      fill: "#cceff1",
      textColor: "#123b3f",
    },
    $render: () => $homeCardStack(),
  },
  {
    label: "home card / text",
    placeholder: {
      id: "home-card-text",
      label: "Text card 420 x 280",
      layout: "contain-center",
      fill: "#ead8ff",
      textColor: "#332247",
    },
    $render: () =>
      $singleHomeCardStage(
        $homeCard({
          id: "candidate-journal",
          title: "Weekly notes",
          $content: SheetRowTextCard.makeWith({
            value: "Ship notes\\nPlan Friday",
            onUpdate: Constants.EMPTY_FUNCTION,
          }),
          icon: LonaIcons.$template(TextIcon),
          contentBg: "var(--bg)",
          checked: true,
        }),
      ),
  },
  {
    label: "home card / number",
    placeholder: {
      id: "home-card-number",
      label: "Number card 420 x 280",
      layout: "contain-center",
      fill: "#d6efcf",
      textColor: "#20371b",
    },
    $render: () =>
      $singleHomeCardStage(
        $homeCard({
          id: "candidate-recovery",
          title: "Recovery",
          $content: SheetRowNumberCard.makeWith({
            value: 82,
            onUpdate: Constants.EMPTY_FUNCTION,
          }),
          icon: LonaIcons.$template(NumberIcon),
          contentBg:
            "color-mix(in srgb, var(--green-dimmed) 35%, var(--bg) 65%)",
          checked: false,
        }),
      ),
  },
  {
    label: "component / all complete",
    placeholder: {
      id: "all-complete",
      label: "Complete 600 x 400",
      layout: "contain-center",
      fill: "#e7e2f1",
      textColor: "#2e2440",
    },
    $render: () => $centeredComponent(AllCompleteState.make(), "320px"),
  },
  {
    label: "component / spotlight",
    placeholder: SPOTLIGHT_PLACEHOLDER,
    $render: FeatureCardContent.$spotlightActions,
  },
];

export class FeatureCardHeroImagePlaceholderStoryBook extends Storybook.Default {
  title(): string {
    return "Feature Card Hero Image Placeholder";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "States",
        render: () => $statesGrid(),
      },
      {
        title: "Actual content candidates",
        render: () => $contentCandidatesGrid(),
      },
    ];
  }
}

function $statesGrid(): HTMLElement {
  const $grid = document.createElement("div");
  $grid.assignStyles({
    display: "grid",
    gridTemplateColumns: "repeat(2, max-content)",
    gap: "16px",
    alignItems: "start",
    overflowX: "auto",
    padding: "4px",
  });

  $grid.append(
    $frame({
      label: "placeholder",
      $content: $placeholder("placeholder", false),
      width: "600px",
      height: "400px",
    }),
    $frame({
      label: "slotted content",
      $content: $placeholder("content", false),
      width: "600px",
      height: "400px",
    }),
  );
  return $grid;
}

function $contentCandidatesGrid(): HTMLElement {
  const $grid = document.createElement("div");
  $grid.assignStyles({
    display: "grid",
    gridTemplateColumns: "repeat(2, max-content)",
    gap: "16px",
    alignItems: "start",
    overflowX: "auto",
    padding: "4px",
  });

  for (const candidate of CONTENT_CANDIDATES) {
    $grid.appendChild($frame({
      label: candidate.label,
      $content: $contentCandidate(candidate),
      width: "520px",
      height: "320px",
    }));
  }

  return $grid;
}

function $placeholder(
  mode: FeatureCardHeroImagePlaceholder.Mode,
  reviewControlled: boolean,
): FeatureCardHeroImagePlaceholder {
  const $asset = FeatureCardHeroImagePlaceholder.makeWith({
    placeholder: SPOTLIGHT_PLACEHOLDER,
    mode,
    reviewControlled,
  });

  if (mode === "content") {
    $asset.appendChild(FeatureCardContent.$spotlightActions());
  }
  return $asset;
}

function $contentCandidate(
  candidate: ContentCandidate,
): FeatureCardHeroImagePlaceholder {
  const $asset = FeatureCardHeroImagePlaceholder.makeWith({
    placeholder: candidate.placeholder,
    mode: "content",
    reviewControlled: false,
  });
  $asset.appendChild(candidate.$render());
  return $asset;
}

function $imageContent(src: string, alt: string): HTMLElement {
  const $img = document.createElement("img");
  $img.src = src;
  $img.alt = alt;
  $img.decoding = "async";
  $img.assignStyles({
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  });
  return $img;
}

function $homeCardStack(): HTMLElement {
  const $stage = $componentStage();
  $stage.assignStyles({
    position: "relative",
    background:
      "linear-gradient(135deg, color-mix(in srgb, var(--teal-dimmed) 45%, " +
      "var(--bg) 55%), var(--bg))",
  });

  const placements: HomeCardPlacement[] = [
    {
      $card: $homeCard({
        id: "candidate-stack-notes",
        title: "Weekly notes",
        $content: SheetRowTextCard.makeWith({
          value: "Ship notes\\nPlan Friday",
          onUpdate: Constants.EMPTY_FUNCTION,
        }),
        icon: LonaIcons.$template(TextIcon),
        contentBg: "var(--bg)",
        checked: true,
      }),
      left: "46px",
      zIndex: "1",
    },
    {
      $card: $homeCard({
        id: "candidate-stack-recovery",
        title: "Recovery",
        $content: SheetRowNumberCard.makeWith({
          value: 82,
          onUpdate: Constants.EMPTY_FUNCTION,
        }),
        icon: LonaIcons.$template(MoonIcon),
        contentBg:
          "color-mix(in srgb, var(--green-dimmed) 35%, var(--bg) 65%)",
        checked: false,
      }),
      left: "198px",
      zIndex: "2",
    },
    {
      $card: $homeCard({
        id: "candidate-stack-focus",
        title: "Focus blocks",
        $content: SheetRowTextCard.makeWith({
          value: "Deep work\\nReview queue",
          onUpdate: Constants.EMPTY_FUNCTION,
        }),
        icon: LonaIcons.$template(CalendarIcon),
        contentBg:
          "color-mix(in srgb, var(--blue-dimmed) 32%, var(--bg) 68%)",
        checked: true,
      }),
      left: "350px",
      zIndex: "3",
    },
  ];

  for (const placement of placements) {
    placement.$card.assignStyles({
      position: "absolute",
      top: "26px",
      left: placement.left,
      transform: "scale(0.68)",
      transformOrigin: "top left",
      zIndex: placement.zIndex,
    });
    $stage.appendChild(placement.$card);
  }
  return $stage;
}

function $singleHomeCardStage($card: HomeGridCard): HTMLElement {
  const $stage = $componentStage();
  $card.assignStyles({
    transform: "scale(0.72)",
    transformOrigin: "center",
  });
  $stage.appendChild($card);
  return $stage;
}

function $centeredComponent($content: HTMLElement, width: string): HTMLElement {
  const $stage = $componentStage();
  $content.assignStyles({
    width,
  });
  $stage.appendChild($content);
  return $stage;
}

function $componentStage(): HTMLElement {
  const $stage = document.createElement("div");
  $stage.assignStyles({
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    display: "grid",
    placeItems: "center",
    padding: "24px",
    overflow: "hidden",
    background: "color-mix(in srgb, var(--bg) 92%, var(--text-pri) 8%)",
  });
  return $stage;
}

type HomeCardSpec = {
  id: string;
  title: string;
  $content: HTMLElement;
  icon: HTMLTemplateElement;
  contentBg: string;
  checked: boolean;
};

type HomeCardPlacement = {
  $card: HomeGridCard;
  left: string;
  zIndex: string;
};

function $homeCard(spec: HomeCardSpec): HomeGridCard {
  const today = NaiveDate.today();
  const $card = HomeGridCard.makeWith(
    {
      id: spec.id,
      title: spec.title,
      caption: "Today",
      card: {
        $content: spec.$content,
        contentBg: spec.contentBg,
        bg: "var(--bg-hover-opaque)",
        backBg: "var(--teal-dimmed)",
      },
      list: {
        $content: Typography.small("Ready for today"),
        $accessory: null,
      },
      $badge: () => RowIcon.make().bind({ icon: null }, { icon: spec.icon }, 16),
      date: NaiveDate.Partial.fromDate(today),
      localDate: today,
      checked: spec.checked,
      hasShadow: true,
      onStateChange: Constants.EMPTY_FUNCTION,
    },
    150,
  );
  $card.toggleMode("cards", false);
  return $card;
}

function $frame(spec: FrameSpec): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.assignStyles({
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  });

  const $label = Typography.small(spec.label);
  $label.assignStyles({
    "--font-size": "var(--text-10px)",
    "--line-height-ratio": "1.1",
    "--margin-top": "0px",
    "--margin-bottom": "0px",
    color: "var(--text-sec)",
  });

  const $frame = document.createElement("div");
  $frame.assignStyles({
    width: spec.width,
    height: spec.height,
    overflow: "hidden",
    borderRadius: "12px",
    border: "1px solid var(--divider)",
    background: "var(--bg)",
  });
  $frame.appendChild(spec.$content);

  $wrap.append($label, $frame);
  return $wrap;
}
