import { Storybook } from "../../ui/storybook";
import { PresentationAssetRegistry } from "../../components/presentation/presentation-asset-registry";
import { LandingFeatureGrid } from "./landing-feature-grid";

const features: LandingFeatureGrid.Feature[] = [
  {
    title: "Calendar rows",
    description: "Bring events into the same sheet as the work around them.",
    span: null,
    assetSrc: "hero/feature/page-and-spotlight",
    hero: null,
  },
  {
    title: "Formula rows",
    description: "Compute rolling metrics across each day, week, and month.",
    span: null,
    assetSrc: "hero/feature/capacity-week",
    hero: null,
  },
  {
    title: "Health rows",
    description: "Line up recovery, sleep, and workouts beside the plan.",
    span: null,
    assetSrc: "hero/feature/spotlight-actions",
    hero: null,
  },
  {
    title: "Scheduling links",
    description: "Publish availability from the same timeline you edit.",
    span: null,
    assetSrc: "hero/feature/scheduling-link",
    hero: null,
  },
  {
    title: "Weather rows",
    description: "Compare forecasts against travel days and outdoor plans.",
    span: null,
    assetSrc: "hero/feature/calendar-context",
    hero: null,
  },
  {
    title: "AI planning",
    description: "Turn a question into a sheet you can inspect and edit.",
    span: null,
    assetSrc: "hero/feature/mobile-week",
    hero: null,
  },
];

const mixedSpanFeatures: LandingFeatureGrid.Feature[] = [
  {
    title: "Full context",
    description:
      "A larger card can carry the product surface without leaving the group.",
    span: 2,
    assetSrc: "hero/feature/page-and-spotlight",
    hero: null,
  },
  {
    title: "Fast capture",
    description: "Short cards keep secondary actions scannable.",
    span: 1,
    assetSrc: "hero/feature/context-card",
    hero: null,
  },
  {
    title: "Live availability",
    description: "Overflow rows stretch without special row markup.",
    span: 1,
    assetSrc: "hero/feature/spotlight-actions",
    hero: null,
  },
  {
    title: "Planning surface",
    description:
      "A single feature can own the whole row when the story needs room.",
    span: 3,
    assetSrc: "hero/feature/task-stack",
    hero: null,
  },
];

export class LandingFeatureGridStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Feature Grid";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Three cards",
        render: () =>
          LandingFeatureGrid.makeWith({
            features: features.slice(0, 3),
            assetRegistry: PresentationAssetRegistry.LONA_APP,
            heroRegistry: null,
            cardTreatment: null,
          }),
      },
      {
        title: "Overflow row",
        render: () =>
          LandingFeatureGrid.makeWith({
            features: features.slice(0, 4),
            assetRegistry: PresentationAssetRegistry.LONA_APP,
            heroRegistry: null,
            cardTreatment: null,
          }),
      },
      {
        title: "Partial final row",
        render: () =>
          LandingFeatureGrid.makeWith({
            features: features.slice(0, 5),
            assetRegistry: PresentationAssetRegistry.LONA_APP,
            heroRegistry: null,
            cardTreatment: null,
          }),
      },
      {
        title: "Mixed spans",
        render: () =>
          LandingFeatureGrid.makeWith({
            features: mixedSpanFeatures,
            assetRegistry: PresentationAssetRegistry.LONA_APP,
            heroRegistry: null,
            cardTreatment: null,
          }),
      },
    ];
  }
}
