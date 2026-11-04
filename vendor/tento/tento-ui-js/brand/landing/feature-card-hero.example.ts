import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { FeatureCardHero } from "./feature-card-hero";
import { FeatureCardHeroLibrary } from "./feature-card-hero-library/library";
import { LandingCard } from "./landing-card";

type HeroCase = {
  label: string;
  props: () => FeatureCardHero.Props;
};

type SlotCase = {
  label: string;
  width: number;
  height: number;
};

type CardCase = {
  label: string;
  width: number;
  height: number;
  imagePosition: "bottom" | "right";
  hero: HeroCase;
};

const capacityWeekCase = heroCase(
  "capacity week",
  "hero/feature/capacity-week",
);
const taskStackCase = heroCase("task stack", "hero/feature/task-stack");
const availabilityCase = heroCase(
  "scheduling link",
  "hero/feature/scheduling-link",
);
const calendarContextCase = heroCase(
  "calendar context",
  "hero/feature/calendar-context",
);
const markedDaysCase = heroCase("marked days", "hero/feature/marked-days");
const mobileWeekCase = heroCase("mobile week", "hero/feature/mobile-week");
const spotlightActionsCase = heroCase(
  "spotlight actions",
  "hero/feature/spotlight-actions",
);
const contextCardCase = heroCase("context card", "hero/feature/context-card");
const pageAndSpotlightCase = heroCase(
  "page + spotlight",
  "hero/feature/page-and-spotlight",
);
const availabilityAndContextCase: HeroCase = {
  label: "availability + context",
  props: () =>
    combineHeroes("hero/feature/scheduling-link", "hero/feature/context-card"),
};
const calendarAndMobileCase: HeroCase = {
  label: "calendar + mobile",
  props: () =>
    combineHeroes(
      "hero/feature/calendar-context",
      "hero/feature/mobile-week",
    ),
};

const HERO_CASES: HeroCase[] = [
  capacityWeekCase,
  taskStackCase,
  availabilityCase,
  calendarContextCase,
  markedDaysCase,
  mobileWeekCase,
  spotlightActionsCase,
  contextCardCase,
  pageAndSpotlightCase,
  availabilityAndContextCase,
  calendarAndMobileCase,
];

const SLOT_CASES: SlotCase[] = [
  { label: "compact", width: 300, height: 190 },
  { label: "unit card", width: 360, height: 220 },
  { label: "wide card", width: 560, height: 260 },
  { label: "right panel", width: 360, height: 240 },
  { label: "mobile square", width: 300, height: 300 },
];

export class FeatureCardHeroStoryBook extends Storybook.Default {
  title(): string {
    return "Feature Card Hero";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Hero slot matrix",
        render: () => $heroSlotMatrix(),
      },
      {
        title: "Brand card matrix",
        render: () => $brandCardMatrix(),
      },
      {
        title: "Single assets",
        render: () => $singleAssetGrid(),
      },
      {
        title: "Narrow readable crop",
        render: () =>
          $heroFrame({
            label: "compact capacity week",
            props: FeatureCardHeroLibrary.hero("hero/feature/capacity-week"),
            width: 300,
            height: 190,
          }),
      },
    ];
  }
}

function heroCase(
  label: string,
  kind: FeatureCardHero.HeroKind,
): HeroCase {
  return {
    label,
    props: () => FeatureCardHeroLibrary.hero(kind),
  };
}

function $heroSlotMatrix(): HTMLElement {
  const $matrix = document.createElement("div");
  $matrix.assignStyles({
    display: "grid",
    gridTemplateColumns: `130px repeat(${SLOT_CASES.length}, max-content)`,
    alignItems: "start",
    gap: "12px",
    overflowX: "auto",
    padding: "4px",
  });

  $matrix.appendChild($matrixLabel(""));
  for (const slot of SLOT_CASES) {
    $matrix.appendChild(
      $matrixLabel(`${slot.label} ${slot.width}x${slot.height}`),
    );
  }

  for (const hero of HERO_CASES) {
    $matrix.appendChild($matrixLabel(hero.label));
    for (const slot of SLOT_CASES) {
      $matrix.appendChild($heroFrame({
        label: `${hero.label} in ${slot.label}`,
        props: hero.props(),
        width: slot.width,
        height: slot.height,
      }));
    }
  }

  return $matrix;
}

function $brandCardMatrix(): HTMLElement {
  const $grid = document.createElement("div");
  $grid.assignStyles({
    display: "grid",
    gridTemplateColumns: "repeat(2, max-content)",
    gap: "16px",
    alignItems: "start",
    overflowX: "auto",
    padding: "4px",
  });

  const cardCases: CardCase[] = [
    {
      label: "bottom capacity week",
      width: 360,
      height: 390,
      imagePosition: "bottom",
      hero: capacityWeekCase,
    },
    {
      label: "bottom task stack",
      width: 420,
      height: 390,
      imagePosition: "bottom",
      hero: taskStackCase,
    },
    {
      label: "bottom page + spotlight",
      width: 420,
      height: 390,
      imagePosition: "bottom",
      hero: pageAndSpotlightCase,
    },
    {
      label: "bottom calendar + mobile",
      width: 420,
      height: 390,
      imagePosition: "bottom",
      hero: calendarAndMobileCase,
    },
    {
      label: "right panel capacity",
      width: 620,
      height: 260,
      imagePosition: "right",
      hero: capacityWeekCase,
    },
    {
      label: "right panel spotlight actions",
      width: 620,
      height: 260,
      imagePosition: "right",
      hero: spotlightActionsCase,
    },
    {
      label: "right page + spotlight",
      width: 620,
      height: 260,
      imagePosition: "right",
      hero: pageAndSpotlightCase,
    },
    {
      label: "right availability + context",
      width: 620,
      height: 260,
      imagePosition: "right",
      hero: availabilityAndContextCase,
    },
  ];

  for (const cardCase of cardCases) {
    $grid.appendChild($cardFrame(cardCase));
  }

  return $grid;
}

function $singleAssetGrid(): HTMLElement {
  const $grid = document.createElement("div");
  $grid.assignStyles({
    display: "grid",
    gridTemplateColumns: "repeat(3, max-content)",
    gap: "14px",
    alignItems: "start",
    overflowX: "auto",
    padding: "4px",
  });

  for (
    const hero of HERO_CASES.slice(
      0,
      FeatureCardHeroLibrary.FEATURES.length,
    )
  ) {
    $grid.appendChild($heroFrame({
      label: hero.label,
      props: hero.props(),
      width: 520,
      height: 260,
    }));
  }

  return $grid;
}

function combineHeroes(
  primaryKind: FeatureCardHero.HeroKind,
  secondaryKind: FeatureCardHero.HeroKind,
): FeatureCardHero.Props {
  const items: FeatureCardHero.Item[] = [];
  const primary = firstHeroItem(primaryKind);
  if (primary) items.push(primary);

  const secondary = firstHeroItem(secondaryKind);
  if (secondary) {
    items.push({
      ...secondary,
      id: `${secondary.id}-peek`,
      layout: "peek-secondary",
    });
  }

  return { items };
}

function firstHeroItem(
  kind: FeatureCardHero.HeroKind,
): Option<FeatureCardHero.Item> {
  return FeatureCardHeroLibrary.hero(kind).items[0] ?? null;
}

function $heroFrame(spec: {
  label: string;
  props: FeatureCardHero.Props;
  width: number;
  height: number;
}): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.assignStyles({
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  });

  const $label = $matrixLabel(spec.label);
  const $frame = document.createElement("div");
  $frame.assignStyles({
    width: `${spec.width}px`,
    height: `${spec.height}px`,
    overflow: "hidden",
    borderRadius: "12px",
    border: "1px solid var(--divider)",
    background: "var(--bg)",
  });
  $frame.appendChild(FeatureCardHero.makeWith(spec.props));

  $wrap.append($label, $frame);
  return $wrap;
}

function $cardFrame(cardCase: CardCase): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.assignStyles({
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  });

  const $card = LandingCard.makeWith({
    title: cardCase.label,
    description:
      "Feature hero assets exercise card media scaling, cropping, and peeking.",
    imagePosition: cardCase.imagePosition,
    renderVisual: () => FeatureCardHero.makeWith(cardCase.hero.props()),
  });
  $card.assignStyles({
    width: `${cardCase.width}px`,
    height: `${cardCase.height}px`,
  });

  $wrap.append($matrixLabel(cardCase.label), $card);
  return $wrap;
}

function $matrixLabel(label: string): HTMLElement {
  const $label = Typography.small(label);
  $label.assignStyles({
    "--font-size": "var(--text-10px)",
    "--line-height-ratio": "1.1",
    "--margin-top": "0px",
    "--margin-bottom": "0px",
    color: "var(--text-sec)",
    maxWidth: "130px",
  });
  return $label;
}
