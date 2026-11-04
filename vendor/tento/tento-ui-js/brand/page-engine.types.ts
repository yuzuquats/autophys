import type { Style } from "../component-styles";
import type { Brand } from "./brand";
import type { JsonValue, NodeKind, PageNode } from "./page-model";

export type NodeRenderer<P = JsonValue> = ComponentFactory<HTMLElement, P> & {
  skeleton: Option<(node: PageNode) => string>;
};

export type Registry<TProps = JsonValue> = Partial<Record<NodeKind, NodeRenderer<TProps>>>;

export type SectionSetName = string;
export type TokenSetName = string;
export type PresetName = string;

export interface SectionSet<TProps = JsonValue> {
  sections: Registry<TProps>;
  chrome: Brand.ChromeVisitor;
}

export type TokenSet = Style.Compat[];

export interface Theme {
  tokens: TokenSetName;
  variant: SectionSetName;
}

/**
 * Per-preset renderer overrides that shadow the default section dictionary.
 * `byId` targets a single section instance; `byKind` targets every node of a
 * kind. Resolution prefers `byId`, then `byKind`, then the section set. See
 * `resolveRenderer`.
 */
export interface RendererOverrides<TProps = JsonValue> {
  byId: Option<Record<string, NodeRenderer<TProps>>>;
  byKind: Option<Partial<Record<NodeKind, NodeRenderer<TProps>>>>;
}

export interface Preset<TProps = JsonValue> {
  name: PresetName;
  theme: Theme;
  overrides: Option<RendererOverrides<TProps>>;
}
