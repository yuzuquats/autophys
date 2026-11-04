import type { AssetPreview } from "../../brand/landing/asset-preview";
import { FeatureCardHero } from "../../brand/landing/feature-card-hero";
import { FeatureCardHeroLibrary } from "../../brand/landing/feature-card-hero-library/library";
import { CheckmarkIcon, LonaIcons, SparkleIcon } from "../../ui/icons";
import { IllustrationMedallion } from "./illustration-medallion";

export class PresentationAssetRegistry {
  private plugins: PresentationAssetRegistry.Plugin[];
  private featureHeroRegistry: Option<FeatureCardHero.Registry> = null;

  constructor(plugins: PresentationAssetRegistry.Plugin[]) {
    this.plugins = plugins;
  }

  resolve(src: string): Option<PresentationAssetRegistry.ResolvedAsset> {
    for (const plugin of this.plugins) {
      const resolved = plugin.resolve(src);
      if (resolved) return resolved;
    }
    return null;
  }

  assets(): PresentationAssetRegistry.AssetDescriptor[] {
    const bySrc = new Map<string, PresentationAssetRegistry.AssetDescriptor>();
    for (const plugin of this.plugins) {
      const assets = plugin.list ? plugin.list() : [];
      for (const asset of assets) {
        if (!bySrc.has(asset.src)) bySrc.set(asset.src, asset);
      }
    }
    return [...bySrc.values()];
  }

  asset(src: string): Option<PresentationAssetRegistry.AssetDescriptor> {
    for (const asset of this.assets()) {
      if (asset.src === src) return asset;
    }
    return null;
  }

  featureHeroAssets(): PresentationAssetRegistry.FeatureHeroAssetDescriptor[] {
    const assets: PresentationAssetRegistry.FeatureHeroAssetDescriptor[] = [];
    for (const asset of this.assets()) {
      if (asset.kind === "feature-hero") assets.push(asset);
    }
    return assets;
  }

  featureHeroAsset(
    src: FeatureCardHero.HeroKind,
  ): Option<PresentationAssetRegistry.FeatureHeroAssetDescriptor> {
    for (const asset of this.featureHeroAssets()) {
      if (asset.src === src) return asset;
    }
    return null;
  }

  asFeatureHeroRegistry(): FeatureCardHero.Registry {
    if (this.featureHeroRegistry) return this.featureHeroRegistry;

    this.featureHeroRegistry = {
      resolveHero: (ref: FeatureCardHero.HeroRef) => {
        const resolved = this.resolve(ref.kind);
        if (!resolved || resolved.kind !== "hero") return null;
        return resolved.props;
      },
    };
    return this.featureHeroRegistry;
  }
}

export namespace PresentationAssetRegistry {
  export type ResolvedAsset =
    | {
      kind: "element";
      $element: HTMLElement;
      label: Option<string>;
    }
    | {
      kind: "hero";
      props: FeatureCardHero.Props;
      label: Option<string>;
    }
    | {
      kind: "image";
      src: string;
      alt: Option<string>;
      label: Option<string>;
    }
    | {
      kind: "video";
      src: string;
      poster: Option<string>;
      label: Option<string>;
    };

  export type FlatPreview = {
    makeContent: () => HTMLElement;
    sizing: AssetPreview.Sizing;
    inertContent: boolean;
    intrinsicSize: Option<Size>;
  };

  export type FeatureHeroAssetDescriptor = {
    kind: "feature-hero";
    src: FeatureCardHero.HeroKind;
    label: string;
    item: FeatureCardHeroLibrary.ItemSpec;
    flatPreview: FlatPreview;
  };

  export type AssetDescriptor =
    | FeatureHeroAssetDescriptor
    | {
      kind: "asset";
      src: string;
      label: string;
      flatPreview: Option<FlatPreview>;
    };

  export type Plugin = {
    id: string;
    resolve: (src: string) => Option<ResolvedAsset>;
    list?: Option<() => AssetDescriptor[]>;
  };

  export function make(
    plugins: PresentationAssetRegistry.Plugin[],
  ): PresentationAssetRegistry {
    return new PresentationAssetRegistry(plugins);
  }

  export function illustrationPlugin(): Plugin {
    const descriptors: AssetDescriptor[] = [
      {
        kind: "asset",
        src: "illustration/stars",
        label: "Stars",
        flatPreview: null,
      },
      {
        kind: "asset",
        src: "illustration/checkmark",
        label: "Complete",
        flatPreview: null,
      },
      {
        kind: "asset",
        src: "illustration/stars-splat",
        label: "Stars — round splat",
        flatPreview: null,
      },
    ];

    // Illustration glyphs default to a fixed 48px but expose a proportional
    // hook: a container (e.g. std-illustration-medallion) can scale the glyph
    // with its tile by setting --illustration-icon-size (the var inherits
    // across the presentation-asset shadow boundary; percentages resolve
    // against the asset stage).
    function $illustrationIcon(
      svg: LonaIcons.RawSvg,
      color: string,
    ): HTMLElement {
      const $icon = LonaIcons.make(svg, { sizePx: 48, color });
      $icon.assignStyles({
        width: "var(--illustration-icon-size, 48px)",
        height: "var(--illustration-icon-size, 48px)",
      });
      return $icon;
    }

    return {
      id: "illustration",
      list: () => descriptors,
      resolve(src: string): Option<ResolvedAsset> {
        if (src === "illustration/stars") {
          return {
            kind: "element",
            $element: $illustrationIcon(SparkleIcon, "currentColor"),
            label: "Stars",
          };
        }

        if (src === "illustration/checkmark") {
          return {
            kind: "element",
            $element: $illustrationIcon(CheckmarkIcon, "var(--green)"),
            label: "Complete",
          };
        }

        if (src === "illustration/stars-splat") {
          return {
            kind: "element",
            $element: IllustrationMedallion.makeWith({
              wash: "sunset-1",
              src: "illustration/stars",
            }),
            label: "Stars",
          };
        }

        return null;
      },
    };
  }

  export function nuxPlugin(): Plugin {
    const nuxAssets: Array<{
      src: string;
      label: string;
    }> = [
      {
        src: "lona-garmin-success",
        label: "Garmin success",
      },
      {
        src: "lona-subscription-success",
        label: "Subscription success",
      },
      {
        src: "lona-day-tz-traveler-nux",
        label: "Day timezone traveler NUX",
      },
    ];

    const descriptors: AssetDescriptor[] = nuxAssets.map((asset) => ({
      kind: "asset",
      src: asset.src,
      label: asset.label,
      flatPreview: {
        makeContent: () => $nuxPlaceholder(asset, { fillFrame: false }),
        sizing: { kind: "scale" },
        inertContent: true,
        intrinsicSize: { width: 240, height: 156 },
      },
    }));

    return {
      id: "nux",
      list: () => descriptors,
      resolve(src: string): Option<ResolvedAsset> {
        const asset = nuxAssets.find((candidate) => candidate.src === src);
        if (!asset) return null;

        return {
          kind: "element",
          $element: $nuxPlaceholder(asset, { fillFrame: true }),
          label: asset.label,
        };
      },
    };
  }

  function $nuxPlaceholder(
    asset: {
      src: string;
    },
    options: {
      fillFrame: boolean;
    },
  ): HTMLElement {
    const $art = document.createElement("div");
    $art.assignStyles({
      position: "relative",
      display: "grid",
      placeItems: "center",
      width: options.fillFrame ? "100%" : "240px",
      height: options.fillFrame ? "100%" : "156px",
      minWidth: "0px",
      minHeight: "0px",
      boxSizing: "border-box",
      color: "var(--fg-icon-sec)",
    });

    const $icon = LonaIcons.make(
      asset.src === "lona-day-tz-traveler-nux" ? SparkleIcon : CheckmarkIcon,
      {
        sizePx: 56,
        color: "var(--fg-icon-sec)",
      },
    );
    $icon.assignStyles({
      position: "relative",
      zIndex: "1",
    });

    $art.append($icon);
    return $art;
  }

  export function featureHeroPlugin(options: {
    registry: FeatureCardHero.Registry;
    specs: FeatureCardHeroLibrary.HeroSpec[];
  }): Plugin {
    const descriptors: FeatureHeroAssetDescriptor[] = [];
    for (const spec of options.specs) {
      const item = spec.items[0];
      if (!item) continue;
      descriptors.push({
        kind: "feature-hero",
        src: spec.kind,
        label: item.label,
        item,
        flatPreview: {
          makeContent: item.makeContent,
          sizing: item.gridFit.kind === "responsive"
            ? { kind: "responsive" }
            : { kind: "scale" },
          inertContent: true,
          intrinsicSize: null,
        },
      });
    }

    return {
      id: "feature-hero",
      list: () => descriptors,
      resolve(src: string): Option<ResolvedAsset> {
        const ref = FeatureCardHero.heroRefFromKind(src);
        if (!ref) return null;

        const props = options.registry.resolveHero(ref);
        if (!props) return null;

        return {
          kind: "hero",
          props,
          label: src,
        };
      },
    };
  }

  export function mediaPlugin(): Plugin {
    return {
      id: "media",
      resolve(src: string): Option<ResolvedAsset> {
        const lower = src.toLowerCase();
        if (
          lower.endsWith(".png") ||
          lower.endsWith(".jpg") ||
          lower.endsWith(".jpeg") ||
          lower.endsWith(".svg") ||
          lower.endsWith(".webp") ||
          lower.startsWith("data:image/")
        ) {
          return { kind: "image", src, alt: null, label: src };
        }

        if (
          lower.endsWith(".mp4") ||
          lower.endsWith(".webm") ||
          lower.startsWith("data:video/")
        ) {
          return { kind: "video", src, poster: null, label: src };
        }

        return null;
      },
    };
  }

  function sharedPlugins(
    featureHeroRegistry: FeatureCardHero.Registry,
  ): PresentationAssetRegistry.Plugin[] {
    return [
      illustrationPlugin(),
      nuxPlugin(),
      featureHeroPlugin({
        registry: featureHeroRegistry,
        specs: FeatureCardHeroLibrary.FEATURES,
      }),
      mediaPlugin(),
    ];
  }

  export const LONA_APP = make(sharedPlugins(FeatureCardHeroLibrary.REGISTRY));
  export const LANDING = make(
    sharedPlugins(FeatureCardHeroLibrary.LANDING_REGISTRY),
  );
  export let DEFAULT = LANDING;

  export function setDefault(registry: PresentationAssetRegistry): void {
    DEFAULT = registry;
  }
}
