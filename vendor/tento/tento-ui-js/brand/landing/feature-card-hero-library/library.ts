import { FeatureCardHero } from "../feature-card-hero";
import { FeatureCardHeroImagePlaceholder } from "../feature-card-hero-image-placeholder";
import { FeatureCardContent } from "./content";

export namespace FeatureCardHeroLibrary {
  // How the flat /gtm asset grid sizes a cell:
  //  - "scale":      the asset lays out at its OWN intrinsic size; the cell only
  //    uniform-scales it to fit (no imposed width/height/aspect-ratio).
  //  - "responsive": rendered at the cell width with NO scale (for components
  //    whose getBoundingClientRect/transforms break under a scaled ancestor,
  //    e.g. the spotlight).
  // (The bento/hero surfaces tile via FeatureCardHero using nativeSize + tile.)
  export type GridFit =
    | { kind: "scale" }
    | { kind: "responsive" };

  export type ItemSpec = {
    id: string;
    label: string;
    nativeSize: Size;
    fill: string;
    textColor: string;
    layout: FeatureCardHero.Layout;
    tile: FeatureCardHero.TileProfile;
    makeContent: () => HTMLElement;
    gridFit: GridFit;
  };

  type RenderOptions = {
    mode: FeatureCardHeroImagePlaceholder.Mode;
    // Review surfaces (/gtm) follow the shared review toolbar's content/placeholder
    // state; other surfaces (/landing) ignore it and stay on `mode`.
    reviewControlled: boolean;
  };

  export type HeroSpec = {
    kind: FeatureCardHero.HeroKind;
    items: ItemSpec[];
  };

  const DEFAULT_RENDER_OPTIONS: RenderOptions = {
    mode: "content",
    reviewControlled: true,
  };

  export const FEATURES: HeroSpec[] = [
    heroSpec("hero/feature/tasks", [
      itemSpec({
        id: "tasks",
        label: "Tasks",
        nativeSize: { width: 360, height: 320 },
        fill: "var(--yellow-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: {
          mobile: "center",
          tablet: "center",
          desktop: "top-center",
        },
        makeContent: FeatureCardContent.$tasks,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/proposals", [
      itemSpec({
        id: "proposals",
        label: "Auto-schedule",
        nativeSize: { width: 400, height: 320 },
        fill: "var(--purple-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "center",
        makeContent: FeatureCardContent.$proposalList,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/calendar-list", [
      itemSpec({
        id: "calendar-list",
        label: "All your calendars",
        nativeSize: { width: 320, height: 360 },
        fill: "var(--blue-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "top-center",
        makeContent: FeatureCardContent.$calendarList,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/quick-add", [
      itemSpec({
        id: "quick-add",
        label: "Quick add",
        nativeSize: { width: 520, height: 280 },
        fill: "var(--purple-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "adaptive-center-bottom-right",
        makeContent: FeatureCardContent.$quickAdd,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/scheduling-link", [
      itemSpec({
        id: "scheduling-link",
        label: "Scheduling link",
        nativeSize: { width: 900, height: 520 },
        fill: "var(--blue-dimmed)",
        textColor: "var(--text-pri)",
        layout: "cover-center",
        tile: "top-left",
        makeContent: FeatureCardContent.$schedulingLink,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/spotlight", [
      itemSpec({
        id: "spotlight",
        label: "Spotlight",
        nativeSize: { width: 560, height: 360 },
        fill: "var(--purple-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "center",
        makeContent: FeatureCardContent.$spotlightActions,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/habit", [
      itemSpec({
        id: "habit",
        label: "Habit",
        nativeSize: { width: 260, height: 340 },
        fill: "var(--red-dimmed)",
        textColor: "var(--text-pri)",
        layout: "cover-center",
        tile: "bottom-peek",
        makeContent: FeatureCardContent.$habitCard,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/flight", [
      itemSpec({
        id: "flight",
        label: "Flight",
        nativeSize: { width: 360, height: 220 },
        fill: "var(--blue-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "center",
        makeContent: FeatureCardContent.$flightCard,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/themes", [
      itemSpec({
        id: "themes",
        label: "Themes",
        // Keep in sync with THEME_PREVIEW_HEIGHT (theme-preview.ts) and the
        // themesCard() one-off hero (content.ts). scaled-bottom renders it at ~60%
        // of the slot width, centered, bleeding off the bottom.
        nativeSize: { width: 260, height: 450 },
        fill: "var(--purple-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "scaled-bottom",
        makeContent: FeatureCardContent.$themes,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/international-calendars", [
      itemSpec({
        id: "international-calendars",
        label: "International calendars",
        nativeSize: { width: 500, height: 228 },
        fill: "var(--orange-dimmed)",
        textColor: "var(--text-pri)",
        layout: "cover-center",
        tile: "inset-bottom-right-bleed",
        makeContent: FeatureCardContent.$internationalCalendars,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/sheets", [
      itemSpec({
        id: "sheets",
        label: "Sheets & rows",
        nativeSize: { width: 470, height: 235 },
        fill: "var(--yellow-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "center",
        makeContent: FeatureCardContent.$sheets,
        gridFit: { kind: "scale" },
      }),
    ]),
    // v1 placeholder heroes — the high-impact marketing concepts that still need
    // a real asset; they render as labeled stand-ins on /gtm. Lower-priority
    // concepts (integrations, teams, formulas, context) are parked in the GTM
    // asset-catalog doc until they earn a card.
    heroSpec("hero/feature/weather", [
      itemSpec({
        id: "weather",
        label: "Weather",
        nativeSize: { width: 190, height: 285 },
        fill: "var(--blue-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "center",
        makeContent: FeatureCardContent.$weather,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/personal-analytics", [
      itemSpec({
        id: "personal-analytics",
        label: "Personal analytics",
        nativeSize: { width: 740, height: 320 },
        fill: "var(--teal-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "center",
        makeContent: FeatureCardContent.$personalAnalyticsChart,
        gridFit: { kind: "scale" },
      }),
    ]),
    placeholderHero({
      kind: "hero/feature/health",
      id: "health",
      label: "Health & fitness",
      fill: "var(--green-dimmed)",
      textColor: "var(--text-pri)",
      nativeSize: { width: 360, height: 320 },
    }),
    heroSpec("hero/feature/timezone", [
      itemSpec({
        id: "timezone",
        label: "Time zones",
        nativeSize: { width: 540, height: 310 },
        fill: "var(--blue-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "center",
        makeContent: FeatureCardContent.$timezoneLegendStack,
        gridFit: { kind: "scale" },
      }),
    ]),
    heroSpec("hero/feature/openings", [
      itemSpec({
        id: "openings",
        label: "Open times",
        nativeSize: { width: 320, height: 240 },
        fill: "var(--blue-dimmed)",
        textColor: "var(--text-pri)",
        layout: "contain-center",
        tile: "center",
        makeContent: FeatureCardContent.$openings,
        gridFit: { kind: "scale" },
      }),
    ]),
  ];

  function registryFor(
    options: RenderOptions,
  ): FeatureCardHero.Registry {
    return FeatureCardHero.registry(
      FEATURES.map((spec) => heroPlugin(spec, options)),
    );
  }

  // Review surfaces (/gtm) follow the visible review toolbar's content/placeholder
  // control.
  export const REGISTRY = registryFor(DEFAULT_RENDER_OPTIONS);

  // /landing: always render real content; not toolbar-controlled.
  export const LANDING_REGISTRY = registryFor({
    ...DEFAULT_RENDER_OPTIONS,
    reviewControlled: false,
  });

  export function hero(kind: FeatureCardHero.HeroKind): FeatureCardHero.Props {
    const props = REGISTRY.resolveHero({ kind });
    if (props) return props;
    return { items: [] };
  }

  function heroPlugin(
    spec: HeroSpec,
    options: RenderOptions,
  ): FeatureCardHero.Plugin {
    return {
      kind: spec.kind,
      makeHero() {
        return {
          items: spec.items.map((itemSpec) => heroItem(itemSpec, options)),
        };
      },
    };
  }

  function heroItem(
    spec: ItemSpec,
    options: RenderOptions,
  ): FeatureCardHero.Item {
    return {
      id: spec.id,
      nativeSize: spec.nativeSize,
      layout: spec.layout,
      tile: spec.tile,
      render: () => $assetFor(spec, options),
    };
  }

  function $assetFor(
    spec: ItemSpec,
    options: RenderOptions,
  ): FeatureCardHeroImagePlaceholder {
    const $asset = FeatureCardHeroImagePlaceholder.makeWith({
      placeholder: {
        id: spec.id,
        label: spec.label,
        layout: spec.layout,
        fill: spec.fill,
        textColor: spec.textColor,
      },
      mode: options.mode,
      reviewControlled: options.reviewControlled,
    });
    $asset.appendChild(spec.makeContent());
    return $asset;
  }

  function heroSpec(
    kind: FeatureCardHero.HeroKind,
    items: ItemSpec[],
  ): HeroSpec {
    return { kind, items };
  }

  function itemSpec(spec: ItemSpec): ItemSpec {
    return spec;
  }

  // A hero whose only item is a placeholder stand-in — a marketing concept that
  // appears across the brand pages but has no real asset component yet. Shows on
  // the /gtm "All assets" grid; inert on live pages (heroes render only where a
  // feature.hero references the kind). Replace makeContent with a real factory
  // when the visual exists.
  function placeholderHero(args: {
    kind: FeatureCardHero.HeroKind;
    id: string;
    label: string;
    fill: string;
    textColor: string;
    nativeSize: Size;
  }): HeroSpec {
    return heroSpec(args.kind, [
      itemSpec({
        id: args.id,
        label: args.label,
        nativeSize: args.nativeSize,
        fill: args.fill,
        textColor: args.textColor,
        layout: "contain-center",
        tile: "center",
        makeContent: () =>
          FeatureCardContent.$placeholder({
            label: args.label,
            id: args.id,
            fill: args.fill,
            textColor: args.textColor,
            size: args.nativeSize,
          }),
        gridFit: { kind: "scale" },
      }),
    ]);
  }
}
