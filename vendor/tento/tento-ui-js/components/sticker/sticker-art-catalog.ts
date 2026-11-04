import { JsonReader, type JsonValue } from "@tento-core/json-reader";
import { StickerCutoutOutline } from "./sticker-cutout-outline";

/**
 * Built-in sticker art: stable sticker ids -> hosted PNG assets + memoized
 * cutout generation. Persisted sticker payloads reference sticker ids only;
 * sets are registry UI metadata for organizing sheets.
 */
export namespace StickerArtCatalog {
  export type TextLoader = (path: string) => Promise<string>;
  export type BytesLoader = (path: string) => Promise<Uint8Array>;

  export type Config = {
    loadText: TextLoader;
    loadBytes: BytesLoader;
  };

  export type License = {
    name: string;
    url: string;
    attribution: string;
  };

  export type SourceKind = "pixel-art" | "emoji" | "image";
  export type ImageRendering = "auto" | "pixelated";
  export type BackgroundCleanup = StickerCutoutOutline.BackgroundCleanup;
  export type SetId = string;
  export type DisplayPolicy =
    | {
      kind: "scale";
      scale: number;
      intrinsicWidth: Option<number>;
      intrinsicHeight: Option<number>;
    }
    | { kind: "fit-height"; height: number };

  export type RegistryMetadata = {
    format: "LONA-STICKER-REGISTRY 1";
    sets: readonly SetDefinition[];
  };

  export type StickerRef = {
    id: string;
    pngPath: string;
    scale: Option<number>;
  };

  export type SetDefinition = {
    id: SetId;
    name: string;
    description: string;
    accent: string;
    imageRendering: Option<ImageRendering>;
    display: Option<DisplayPolicy>;
    stickers: readonly StickerRef[];
  };

  export type StickerMetadata = {
    label: Option<string>;
    alt: Option<string>;
    sourceKind: Option<SourceKind>;
    sourceFilename: Option<string>;
    sourceUrl: Option<string>;
    license: Option<License>;
    intrinsicWidth: Option<number>;
    intrinsicHeight: Option<number>;
    displayScale: Option<number>;
    displayWidth: Option<number>;
    displayHeight: Option<number>;
    backgroundCleanup: Option<BackgroundCleanup>;
    trimTransparentPadding: Option<boolean>;
    imageRendering: Option<ImageRendering>;
  };

  export type Asset = {
    id: string;
    label: string;
    alt: string;
    sourceKind: SourceKind;
    pngPath: string;
    metadataPath: string;
    intrinsicWidth: number;
    intrinsicHeight: number;
    displayScale: number;
    rasterScale: number;
    rasterWidth: number;
    rasterHeight: number;
    displayWidth: number;
    displayHeight: number;
    backgroundCleanup: Option<BackgroundCleanup>;
    trimTransparentPadding: boolean;
    sizeLabel: string;
    sourceFilename: string;
    sourceUrl: string;
    license: Option<License>;
    imageRendering: ImageRendering;
  };

  export type StickerSet = {
    id: SetId;
    name: string;
    description: string;
    accent: string;
    assets: readonly Asset[];
  };

  export type StickerSetSummary = {
    id: SetId;
    name: string;
    description: string;
    accent: string;
    stickerCount: number;
  };

  export type Registry = {
    metadata: RegistryMetadata;
    assets: readonly Asset[];
    sets: readonly StickerSet[];
  };

  export type Catalog = Registry;

  type RegistryIndex = {
    metadata: RegistryMetadata;
    refs: readonly StickerRef[];
    refById: ReadonlyMap<string, StickerRef>;
    definitionById: ReadonlyMap<SetId, SetDefinition>;
    displayPolicyById: ReadonlyMap<string, ResolvedDisplayPolicy>;
  };

  type ResolvedDisplayPolicy = {
    imageRendering: ImageRendering;
    display: DisplayPolicy;
    scaleOverride: Option<number>;
  };

  export type DisplaySize = {
    width: number;
    height: number;
  };

  export const REGISTRY_STATIC_PATH = "/img/stickers/registry.json";
  export const PNG_CATALOG_STATIC_PATH = REGISTRY_STATIC_PATH;
  export const DEFAULT_SET_ID: SetId = "lona-pixel-town";
  export const FALLBACK_SET_NAME = "Stickers";
  export const FALLBACK_SET_DESCRIPTION = "Loading hosted stickers";
  export const FALLBACK_SET_ACCENT = "var(--purple)";
  export const COLLECTION_ACCENT = FALLBACK_SET_ACCENT;
  export const FALLBACK_COLLECTION_NAME = FALLBACK_SET_NAME;
  export const FALLBACK_COLLECTION_DESCRIPTION = FALLBACK_SET_DESCRIPTION;

  const DEFAULT_INTRINSIC_WIDTH = 72;
  const DEFAULT_INTRINSIC_HEIGHT = 72;
  const DEFAULT_DISPLAY_SCALE = 1;
  const CUTOUT_PADDING_PX = 6;
  const CUTOUT_WIDTH_PX = 6;
  const CUTOUT_SMOOTHING_PX = 4;

  /** Shared cutout treatment for built-in stickers: a tight white
   *  paper-cutout *shape* only. Depth (drop shadow when raised, inner
   *  shadow when recessed) is applied per surface by the `depth` prop on
   *  `StickerCutoutPreview`, not baked into the cutout. */
  const CUTOUT_STYLE: StickerCutoutOutline.Style = {
    paddingPx: CUTOUT_PADDING_PX,
    cutoutWidthPx: CUTOUT_WIDTH_PX,
    smoothingPx: CUTOUT_SMOOTHING_PX,
  };

  let config: Option<Config> = null;
  let registryPromise: Option<Promise<Registry>> = null;
  let registryIndexPromise: Option<Promise<RegistryIndex>> = null;
  const assetCache = new Map<string, Promise<Asset>>();
  const pngBytesCache = new Map<string, Promise<Uint8Array>>();
  const cutoutCache = new Map<string, Promise<StickerCutoutOutline.Result>>();

  export function configure(nextConfig: Config): void {
    config = nextConfig;
    registryPromise = null;
    registryIndexPromise = null;
    assetCache.clear();
    pngBytesCache.clear();
    cutoutCache.clear();
  }

  export function isConfigured(): boolean {
    return config != null;
  }

  export async function load(): Promise<Registry> {
    const cached = registryPromise;
    if (cached) return cached;

    const next = loadRegistry();
    registryPromise = next;
    next.catch(() => {
      if (registryPromise === next) registryPromise = null;
    });
    return next;
  }

  export async function assets(): Promise<readonly Asset[]> {
    return (await load()).assets;
  }

  export async function asset(id: string): Promise<Option<Asset>> {
    const index = await loadRegistryIndex();
    const ref = index.refById.get(id) ?? null;
    if (!ref) return null;
    return cachedAssetFromStickerRef(
      ref,
      requireConfig(),
      index.displayPolicyById.get(id) ?? null,
    );
  }

  export async function sets(): Promise<readonly StickerSet[]> {
    return (await load()).sets;
  }

  export async function setSummaries(): Promise<readonly StickerSetSummary[]> {
    const index = await loadRegistryIndex();
    return index.metadata.sets.map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      accent: definition.accent,
      stickerCount: definition.stickers.length,
    }));
  }

  export async function set(id: SetId): Promise<Option<StickerSet>> {
    return setWithAssetLimit(id, null);
  }

  export async function setPreview(
    id: SetId,
    assetLimit: number,
  ): Promise<Option<StickerSet>> {
    return setWithAssetLimit(id, Math.max(0, Math.floor(assetLimit)));
  }

  async function setWithAssetLimit(
    id: SetId,
    assetLimit: Option<number>,
  ): Promise<Option<StickerSet>> {
    const index = await loadRegistryIndex();
    const definition = index.definitionById.get(id) ?? null;
    if (!definition) return null;

    const refs = assetLimit == null
      ? definition.stickers
      : definition.stickers.slice(0, assetLimit);
    const assets = await Promise.all(
      refs.map((ref) =>
        cachedAssetFromStickerRef(
          ref,
          requireConfig(),
          index.displayPolicyById.get(ref.id) ?? null,
        )
      ),
    );
    return setFromAssets(definition, assets);
  }

  /**
   * Memoized cutout generation for a built-in asset. Returns null for
   * unknown ids (stale clients reading newer payloads). A failed generation
   * is evicted so a later bind can retry.
   */
  export async function cutout(
    id: string,
  ): Promise<Option<StickerCutoutOutline.Result>> {
    const found = await asset(id);
    if (!found) return null;

    const cached = cutoutCache.get(id);
    if (cached) return cached;

    const generated = Promise.resolve().then(async () => {
      const pngBytes = await cachedPngBytes(found.pngPath, requireConfig());
      const options: StickerCutoutOutline.Options = {
        id: `sticker-art-${id}`,
        style: cutoutStyleForAsset(found),
        rasterScale: found.displayScale,
        trimTransparentPadding: found.trimTransparentPadding,
      };
      if (found.backgroundCleanup) {
        options.backgroundCleanup = found.backgroundCleanup;
      }
      return StickerCutoutOutline.generateSvgFromPngBytes(pngBytes, options);
    });
    cutoutCache.set(id, generated);
    generated.catch(() => cutoutCache.delete(id));
    return generated;
  }

  export function resolveDisplaySize(asset: Asset): DisplaySize {
    return {
      width: asset.displayWidth,
      height: asset.displayHeight,
    };
  }

  async function loadRegistry(): Promise<Registry> {
    const index = await loadRegistryIndex();
    const assets = await Promise.all(
      index.refs.map((ref) =>
        cachedAssetFromStickerRef(
          ref,
          requireConfig(),
          index.displayPolicyById.get(ref.id) ?? null,
        )
      ),
    );
    const assetById = new Map<string, Asset>();
    for (const asset of assets) assetById.set(asset.id, asset);
    return {
      metadata: index.metadata,
      assets,
      sets: setsFromMetadata(index.metadata, assetById),
    };
  }

  async function loadRegistryIndex(): Promise<RegistryIndex> {
    const cached = registryIndexPromise;
    if (cached) return cached;

    const next = Promise.resolve().then(async () => {
      const metadataText = await requireConfig().loadText(REGISTRY_STATIC_PATH);
      return registryIndexFromMetadata(parseRegistryMetadata(metadataText));
    });
    registryIndexPromise = next;
    next.catch(() => {
      if (registryIndexPromise === next) registryIndexPromise = null;
    });
    return next;
  }

  function cutoutStyleForAsset(asset: Asset): StickerCutoutOutline.Style {
    const scale = cutoutCoordinateScale(asset);
    return {
      paddingPx: Math.ceil(CUTOUT_PADDING_PX * scale),
      cutoutWidthPx: Math.ceil(CUTOUT_WIDTH_PX * scale),
      smoothingPx: Math.ceil(CUTOUT_SMOOTHING_PX * scale),
    };
  }

  function cutoutCoordinateScale(asset: Asset): number {
    return Math.max(
      asset.rasterWidth / asset.displayWidth,
      asset.rasterHeight / asset.displayHeight,
    );
  }

  function registryIndexFromMetadata(
    metadata: RegistryMetadata,
  ): RegistryIndex {
    const refs = uniqueStickerRefs(metadata.sets);
    const refById = new Map<string, StickerRef>();
    for (const ref of refs) refById.set(ref.id, ref);
    const definitionById = new Map<SetId, SetDefinition>();
    const displayPolicyById = new Map<string, ResolvedDisplayPolicy>();
    for (const definition of metadata.sets) {
      if (definitionById.has(definition.id)) {
        throw new Error(`duplicate sticker set id "${definition.id}"`);
      }
      definitionById.set(definition.id, definition);
      for (const ref of definition.stickers) {
        const displayPolicy = displayPolicyForRef(definition, ref);
        if (!displayPolicy) continue;
        const existing = displayPolicyById.get(ref.id) ?? null;
        if (existing && !sameDisplayPolicy(existing, displayPolicy)) {
          throw new Error(
            `sticker id "${ref.id}" has multiple display policies`,
          );
        }
        displayPolicyById.set(ref.id, displayPolicy);
      }
    }
    return {
      metadata,
      refs,
      refById,
      definitionById,
      displayPolicyById,
    };
  }

  function uniqueStickerRefs(
    definitions: readonly SetDefinition[],
  ): readonly StickerRef[] {
    const refs = new Map<string, StickerRef>();
    for (const definition of definitions) {
      const idsInSet = new Set<string>();
      for (const ref of definition.stickers) {
        if (idsInSet.has(ref.id)) {
          throw new Error(
            `duplicate sticker id "${ref.id}" in set "${definition.id}"`,
          );
        }
        idsInSet.add(ref.id);
        const existing = refs.get(ref.id) ?? null;
        if (existing && existing.pngPath !== ref.pngPath) {
          throw new Error(`sticker id "${ref.id}" has multiple PNG paths`);
        }
        refs.set(ref.id, ref);
      }
    }
    return [...refs.values()];
  }

  function setsFromMetadata(
    metadata: RegistryMetadata,
    assetById: ReadonlyMap<string, Asset>,
  ): readonly StickerSet[] {
    const ids = new Set<SetId>();
    const sets: StickerSet[] = [];
    for (const definition of metadata.sets) {
      if (ids.has(definition.id)) {
        throw new Error(`duplicate sticker set id "${definition.id}"`);
      }
      ids.add(definition.id);
      sets.push(setFromDefinition(definition, assetById));
    }
    return sets;
  }

  function setFromDefinition(
    definition: SetDefinition,
    assetById: ReadonlyMap<string, Asset>,
  ): StickerSet {
    const assets: Asset[] = [];
    for (const ref of definition.stickers) {
      const asset = assetById.get(ref.id) ?? null;
      if (!asset) {
        throw new Error(
          `sticker set "${definition.id}" references missing sticker "${ref.id}"`,
        );
      }
      assets.push(asset);
    }
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      accent: definition.accent,
      assets,
    };
  }

  function setFromAssets(
    definition: SetDefinition,
    assets: readonly Asset[],
  ): StickerSet {
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      accent: definition.accent,
      assets,
    };
  }

  async function assetFromStickerRef(
    ref: StickerRef,
    config: Config,
    displayPolicy: Option<ResolvedDisplayPolicy>,
  ): Promise<Asset> {
    if (displayPolicy) {
      return assetFromDisplayPolicy(ref, config, displayPolicy);
    }

    const metadataPath = stickerMetadataPath(ref.pngPath);
    const metadata = await loadStickerMetadata(config, metadataPath);
    const intrinsicWidth = metadata?.intrinsicWidth ?? DEFAULT_INTRINSIC_WIDTH;
    const intrinsicHeight = metadata?.intrinsicHeight ??
      DEFAULT_INTRINSIC_HEIGHT;
    const displayScale = metadata?.displayScale ?? DEFAULT_DISPLAY_SCALE;
    const displayWidth = metadata?.displayWidth ??
      intrinsicWidth * displayScale;
    const displayHeight = metadata?.displayHeight ??
      intrinsicHeight * displayScale;
    return {
      id: ref.id,
      label: metadata?.label ?? fallbackLabel(ref.id),
      alt: metadata?.alt ?? fallbackLabel(ref.id),
      sourceKind: metadata?.sourceKind ?? "image",
      pngPath: ref.pngPath,
      metadataPath,
      intrinsicWidth,
      intrinsicHeight,
      displayScale,
      rasterScale: displayScale,
      rasterWidth: intrinsicWidth * displayScale,
      rasterHeight: intrinsicHeight * displayScale,
      displayWidth,
      displayHeight,
      backgroundCleanup: metadata?.backgroundCleanup ?? null,
      trimTransparentPadding: metadata?.trimTransparentPadding ?? false,
      sizeLabel: `${intrinsicWidth}x${intrinsicHeight} @ ${displayScale}x`,
      sourceFilename: metadata?.sourceFilename ?? filenameFromPath(ref.pngPath),
      sourceUrl: metadata?.sourceUrl ?? ref.pngPath,
      license: metadata?.license ?? null,
      imageRendering: metadata?.imageRendering ?? "auto",
    };
  }

  function cachedAssetFromStickerRef(
    ref: StickerRef,
    config: Config,
    displayPolicy: Option<ResolvedDisplayPolicy>,
  ): Promise<Asset> {
    const cached = assetCache.get(ref.id) ?? null;
    if (cached) return cached;
    const next = assetFromStickerRef(ref, config, displayPolicy);
    assetCache.set(ref.id, next);
    next.catch(() => assetCache.delete(ref.id));
    return next;
  }

  async function assetFromDisplayPolicy(
    ref: StickerRef,
    config: Config,
    displayPolicy: ResolvedDisplayPolicy,
  ): Promise<Asset> {
    const metadataPath = stickerMetadataPath(ref.pngPath);
    const intrinsicSize = await displayPolicyIntrinsicSize(
      ref,
      config,
      displayPolicy.display,
    );
    const intrinsicWidth = intrinsicSize.width;
    const intrinsicHeight = intrinsicSize.height;
    const displayScale = displayScaleForPolicy(displayPolicy);
    const rasterWidth = intrinsicWidth * displayScale;
    const rasterHeight = intrinsicHeight * displayScale;
    const displaySize = displaySizeForPolicy(
      displayPolicy,
      rasterWidth,
      rasterHeight,
    );
    return {
      id: ref.id,
      label: fallbackLabel(ref.id),
      alt: fallbackLabel(ref.id),
      sourceKind: sourceKindForPolicy(displayPolicy),
      pngPath: ref.pngPath,
      metadataPath,
      intrinsicWidth,
      intrinsicHeight,
      displayScale,
      rasterScale: displayScale,
      rasterWidth,
      rasterHeight,
      displayWidth: displaySize.width,
      displayHeight: displaySize.height,
      backgroundCleanup: null,
      trimTransparentPadding: false,
      sizeLabel: sizeLabelForPolicy(
        intrinsicWidth,
        intrinsicHeight,
        displayPolicy,
      ),
      sourceFilename: filenameFromPath(ref.pngPath),
      sourceUrl: ref.pngPath,
      license: null,
      imageRendering: displayPolicy.imageRendering,
    };
  }

  function cachedPngBytes(path: string, config: Config): Promise<Uint8Array> {
    const cached = pngBytesCache.get(path) ?? null;
    if (cached) return cached;
    const next = config.loadBytes(path);
    pngBytesCache.set(path, next);
    next.catch(() => pngBytesCache.delete(path));
    return next;
  }

  async function displayPolicyIntrinsicSize(
    ref: StickerRef,
    config: Config,
    policy: DisplayPolicy,
  ): Promise<DisplaySize> {
    if (
      policy.kind === "scale" &&
      policy.intrinsicWidth != null &&
      policy.intrinsicHeight != null
    ) {
      return {
        width: policy.intrinsicWidth,
        height: policy.intrinsicHeight,
      };
    }

    const pngBytes = await cachedPngBytes(ref.pngPath, config);
    const pngMetadata = StickerCutoutOutline.parsePngMetadata(pngBytes);
    return {
      width: pngMetadata.width,
      height: pngMetadata.height,
    };
  }

  function displayPolicyForRef(
    definition: SetDefinition,
    ref: StickerRef,
  ): Option<ResolvedDisplayPolicy> {
    if (!definition.display) return null;
    return {
      imageRendering: definition.imageRendering ?? "auto",
      display: definition.display,
      scaleOverride: ref.scale,
    };
  }

  function sameDisplayPolicy(
    a: ResolvedDisplayPolicy,
    b: ResolvedDisplayPolicy,
  ): boolean {
    if (a.imageRendering !== b.imageRendering) return false;
    if (a.scaleOverride !== b.scaleOverride) return false;
    if (a.display.kind !== b.display.kind) return false;
    if (a.display.kind === "scale" && b.display.kind === "scale") {
      return a.display.scale === b.display.scale &&
        a.display.intrinsicWidth === b.display.intrinsicWidth &&
        a.display.intrinsicHeight === b.display.intrinsicHeight;
    }
    if (a.display.kind === "fit-height" && b.display.kind === "fit-height") {
      return a.display.height === b.display.height;
    }
    return false;
  }

  function displayScaleForPolicy(policy: ResolvedDisplayPolicy): number {
    if (policy.display.kind === "scale") {
      return policy.scaleOverride ?? policy.display.scale;
    }
    return 1;
  }

  function displaySizeForPolicy(
    policy: ResolvedDisplayPolicy,
    rasterWidth: number,
    rasterHeight: number,
  ): DisplaySize {
    if (policy.display.kind === "scale") {
      return {
        width: rasterWidth,
        height: rasterHeight,
      };
    }

    const height = policy.display.height;
    return {
      width: Math.max(1, Math.round((rasterWidth * height) / rasterHeight)),
      height,
    };
  }

  function sourceKindForPolicy(policy: ResolvedDisplayPolicy): SourceKind {
    return policy.imageRendering === "pixelated" ? "pixel-art" : "image";
  }

  function sizeLabelForPolicy(
    intrinsicWidth: number,
    intrinsicHeight: number,
    policy: ResolvedDisplayPolicy,
  ): string {
    if (policy.display.kind === "scale") {
      return `${intrinsicWidth}x${intrinsicHeight} @ ${
        displayScaleForPolicy(policy)
      }x`;
    }
    return `${intrinsicWidth}x${intrinsicHeight} fit ${policy.display.height}px`;
  }

  async function loadStickerMetadata(
    config: Config,
    path: string,
  ): Promise<Option<StickerMetadata>> {
    const text = await config.loadText(path).catch(() => null);
    if (!text) return null;
    try {
      return parseStickerMetadata(text);
    } catch {
      return null;
    }
  }

  function parseRegistryMetadata(text: string): RegistryMetadata {
    const obj = JsonReader.parseObject(text, "sticker registry");
    const format = JsonReader.string(obj, "format", "sticker registry");
    if (format !== "LONA-STICKER-REGISTRY 1") {
      throw new Error(`unsupported sticker registry format "${format}"`);
    }
    return {
      format,
      sets: JsonReader.array(obj, "sets", "sticker registry").map(
        (value, index) => parseSetDefinition(value, index),
      ),
    };
  }

  function parseSetDefinition(
    value: JsonValue,
    index: number,
  ): SetDefinition {
    const label = `sticker registry sets[${index}]`;
    const obj = JsonReader.object(value, label);
    return {
      id: JsonReader.string(obj, "id", label),
      name: JsonReader.string(obj, "name", label),
      description: JsonReader.string(obj, "description", label),
      accent: JsonReader.string(obj, "accent", label),
      imageRendering: readOptionalImageRendering(obj, label),
      display: readOptionalDisplayPolicy(obj, label),
      stickers: JsonReader.array(obj, "stickers", label).map(
        (stickerValue, stickerIndex) =>
          parseStickerRef(stickerValue, label, stickerIndex),
      ),
    };
  }

  function parseStickerRef(
    value: JsonValue,
    setLabel: string,
    index: number,
  ): StickerRef {
    const label = `${setLabel}.stickers[${index}]`;
    const obj = JsonReader.object(value, label);
    return {
      id: JsonReader.string(obj, "id", label),
      pngPath: JsonReader.string(obj, "pngPath", label),
      scale: JsonReader.optionalPositiveInteger(obj, "scale", label),
    };
  }

  function readOptionalDisplayPolicy(
    obj: JsonReader.Object,
    label: string,
  ): Option<DisplayPolicy> {
    const value = obj.display ?? null;
    if (value == null) return null;
    const display = JsonReader.object(value, `${label}.display`);
    const kind = JsonReader.string(display, "kind", `${label}.display`);
    if (kind === "scale") {
      const intrinsicWidth = JsonReader.optionalPositiveInteger(
        display,
        "intrinsicWidth",
        `${label}.display`,
      );
      const intrinsicHeight = JsonReader.optionalPositiveInteger(
        display,
        "intrinsicHeight",
        `${label}.display`,
      );
      if ((intrinsicWidth == null) !== (intrinsicHeight == null)) {
        throw new Error(
          `${label}.display must provide both intrinsicWidth and intrinsicHeight`,
        );
      }
      return {
        kind,
        scale: JsonReader.positiveInteger(display, "scale", `${label}.display`),
        intrinsicWidth,
        intrinsicHeight,
      };
    }
    if (kind === "fit-height") {
      return {
        kind,
        height: JsonReader.positiveInteger(
          display,
          "height",
          `${label}.display`,
        ),
      };
    }
    throw new Error(`${label}.display.kind must be a supported sticker policy`);
  }

  function parseStickerMetadata(text: string): StickerMetadata {
    const obj = JsonReader.parseObject(text, "sticker metadata");
    const format = JsonReader.string(obj, "format", "sticker metadata");
    if (format !== "LONA-STICKER-METADATA 1") {
      throw new Error(`unsupported sticker metadata format "${format}"`);
    }
    return {
      label: JsonReader.optionalString(obj, "label", "sticker metadata"),
      alt: JsonReader.optionalString(obj, "alt", "sticker metadata"),
      sourceKind: readOptionalSourceKind(obj),
      sourceFilename: JsonReader.optionalString(
        obj,
        "sourceFilename",
        "sticker metadata",
      ),
      sourceUrl: JsonReader.optionalString(
        obj,
        "sourceUrl",
        "sticker metadata",
      ),
      license: readOptionalLicense(obj),
      intrinsicWidth: JsonReader.optionalPositiveInteger(
        obj,
        "intrinsicWidth",
        "sticker metadata",
      ),
      intrinsicHeight: JsonReader.optionalPositiveInteger(
        obj,
        "intrinsicHeight",
        "sticker metadata",
      ),
      displayScale: JsonReader.optionalPositiveInteger(
        obj,
        "displayScale",
        "sticker metadata",
      ),
      displayWidth: JsonReader.optionalPositiveInteger(
        obj,
        "displayWidth",
        "sticker metadata",
      ),
      displayHeight: JsonReader.optionalPositiveInteger(
        obj,
        "displayHeight",
        "sticker metadata",
      ),
      backgroundCleanup: readOptionalBackgroundCleanup(obj),
      trimTransparentPadding: JsonReader.optionalBoolean(
        obj,
        "trimTransparentPadding",
        "sticker metadata",
      ),
      imageRendering: readOptionalImageRendering(obj, "sticker metadata"),
    };
  }

  function readOptionalSourceKind(
    obj: JsonReader.Object,
  ): Option<SourceKind> {
    const value = JsonReader.optionalString(
      obj,
      "sourceKind",
      "sticker metadata",
    );
    if (value == null) return null;
    if (value === "pixel-art" || value === "emoji" || value === "image") {
      return value;
    }
    throw new Error(
      "sticker metadata.sourceKind must be a supported source kind",
    );
  }

  function readOptionalImageRendering(
    obj: JsonReader.Object,
    label: string,
  ): Option<ImageRendering> {
    const value = JsonReader.optionalString(
      obj,
      "imageRendering",
      label,
    );
    if (value == null) return null;
    if (value === "auto" || value === "pixelated") return value;
    throw new Error(`${label}.imageRendering must be supported`);
  }

  function readOptionalBackgroundCleanup(
    obj: JsonReader.Object,
  ): Option<BackgroundCleanup> {
    const value = JsonReader.optionalString(
      obj,
      "backgroundCleanup",
      "sticker metadata",
    );
    if (value == null) return null;
    if (value === "edge-checkerboard") return value;
    throw new Error("sticker metadata.backgroundCleanup must be supported");
  }

  function readOptionalLicense(
    obj: JsonReader.Object,
  ): Option<License> {
    if (obj.license == null) return null;
    const license = JsonReader.childObject(obj, "license", "sticker metadata");
    return {
      name: JsonReader.string(license, "name", "sticker metadata.license"),
      url: JsonReader.string(license, "url", "sticker metadata.license"),
      attribution: JsonReader.string(
        license,
        "attribution",
        "sticker metadata.license",
      ),
    };
  }

  function stickerMetadataPath(pngPath: string): string {
    if (pngPath.endsWith(".png")) return `${pngPath.slice(0, -4)}.sticker.json`;
    return `${pngPath}.sticker.json`;
  }

  function filenameFromPath(path: string): string {
    const pieces = path.split("/");
    return pieces[pieces.length - 1] ?? path;
  }

  function fallbackLabel(id: string): string {
    return id
      .split("-")
      .filter((part) => part.length > 0)
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function requireConfig(): Config {
    if (!config) {
      throw new Error(
        "StickerArtCatalog is not configured with static loaders",
      );
    }
    return config;
  }
}
