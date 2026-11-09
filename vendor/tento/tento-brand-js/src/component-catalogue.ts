import { CoreUi } from "./core-ui";
import { ComponentSlots } from "./component-slots";

/** Portable story contracts. Only the host imports the UI Storybook runtime. */
export type ComponentCatalogueEntry = {
  id: string;
  /** Classification hint, constrained by ComponentSlots. Custom identities
   * belong in one-offs; model bindings do not extend Brand or Core UI slots. */
  layer?: "core" | "branding" | "one-off";
  coreId?: CoreUi.Id;
  /** Explicit semantic identity when a native section uses a local story ID.
   * A binding to data alone is insufficient to claim the complete Brand slot. */
  brandId?: ComponentSlots.BrandId;
  /** The design that implements this component, when a design reuses another
   * design's (Contrast shows Starter's). Hosts name a component by its ID
   * and show the owner beside it, so no entry authors a display name. Absent
   * means the declaring design. */
  owner?: string;
  /** Direct PageNode kinds, IDs/field paths, or model types this subject renders. Empty
   * means nested UI only; absent means the package has not declared it. */
  modelSlots?: readonly string[];
};
export type ComponentCatalogue = readonly ComponentCatalogueEntry[];
export type ComponentSubject = HTMLElement | SVGElement;
export type ComponentRenderResult = ComponentSubject | {
  $content: ComponentSubject;
  $controls?: HTMLElement | null;
  $status?: HTMLElement | null;
  /** Retire plain-DOM timers/listeners when the host removes this specimen. */
  dispose?: () => void;
};
export type ComponentStyle = string | CSSStyleSheet | HTMLStyleElement;
export type ComponentExample = {
  title?: string | null;
  /** Existing review canvas sizing; the native subject is never wrapped again. */
  sizing?: "fill" | "content";
  /** Required surroundings for transparent text, never a design-wide default.
   * Omit for the normal transparent gallery canvas. */
  surface?: "dark" | "accent";
  /** Styles for a plain-DOM subject, installed in the existing review host. */
  styles?: readonly ComponentStyle[];
  render: (() => ComponentRenderResult) | (() => Promise<ComponentRenderResult>);
};
export interface ComponentStory {
  title(): string;
  description?(): string | null;
  tags(): string[];
  preview(): ComponentExample;
  examples(): ComponentExample[];
}
export type ComponentStories = Readonly<Record<string, () => ComponentStory>>;

export function validateComponentCatalogue(value: unknown): asserts value is ComponentCatalogue | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error("componentCatalogue must be an ordered array");
  const ids = new Set<string>();
  const coreSlots = new Set<CoreUi.Id>();
  const brandSlots = new Set<ComponentSlots.BrandId>();
  for (const entry of value) {
    if (!entry || typeof entry.id !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(entry.id)) {
      throw new Error("componentCatalogue requires stable IDs");
    }
    if (entry.layer !== undefined && !["core", "branding", "one-off"].includes(entry.layer)) throw new Error(`component "${entry.id}" has an invalid layer`);
    if (entry.coreId !== undefined && (!CoreUi.IDS.some(id => id === entry.coreId) || entry.layer !== "core")) throw new Error(`component "${entry.id}" has invalid core identity`);
    if (entry.brandId !== undefined && (!ComponentSlots.BRAND_IDS.some(id => id === entry.brandId) || entry.layer !== "branding")) throw new Error("component " + entry.id + " has invalid Brand identity");
    if (entry.owner !== undefined && (typeof entry.owner !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.owner))) {
      throw new Error(`component "${entry.id}" owner must name a design`);
    }
    if (entry.modelSlots !== undefined && (!Array.isArray(entry.modelSlots) ||
      entry.modelSlots.some((slot: unknown) => typeof slot !== "string" || !slot.trim() ||
        slot !== slot.trim() || slot.length > 128 || /[\r\n\t]/.test(slot)) ||
      new Set(entry.modelSlots).size !== entry.modelSlots.length)) {
      throw new Error('component "' + entry.id + '" modelSlots must be distinct nonempty labels');
    }
    if (ComponentSlots.groupOf(entry) === "core") {
      const slot = ComponentSlots.coreId(entry)!;
      if (coreSlots.has(slot)) throw new Error("duplicate core slot " + slot + "; declare story variants instead");
      coreSlots.add(slot);
    }
    if (ComponentSlots.groupOf(entry) === "branding") {
      const slot = ComponentSlots.brandId(entry)!;
      if (brandSlots.has(slot)) throw new Error("duplicate Brand slot " + slot + "; declare story variants instead");
      brandSlots.add(slot);
    }
    if (ids.has(entry.id)) throw new Error(`duplicate component ID "${entry.id}"`);
    ids.add(entry.id);
  }
}

/** Validate factories without invoking stories or loading any UI runtime. */
export function validateComponentStories(catalogue: ComponentCatalogue | undefined, stories: unknown): void {
  if (!catalogue && stories === undefined) return;
  if (!catalogue || !stories || typeof stories !== "object" || Array.isArray(stories)) {
    throw new Error("componentCatalogue requires matching componentStories factories");
  }
  const held = stories as Record<string, unknown>;
  const ids = new Set(catalogue.map(entry => entry.id));
  for (const entry of catalogue) {
    if (!Object.hasOwn(held, entry.id) || typeof held[entry.id] !== "function") {
      throw new Error(`component "${entry.id}" has no story factory`);
    }
  }
  for (const id of Object.keys(held)) {
    if (!ids.has(id)) throw new Error(`unknown component story "${id}"`);
  }
}
