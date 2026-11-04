import type { JsonValue, PageNode } from "./page-model";
import type {
  NodeRenderer,
  Registry,
  RendererOverrides,
} from "./page-engine.types";

/**
 * Resolve the renderer for a node, most-specific first:
 *
 *   overrides.byId[node.id]  →  this exact section instance
 *   overrides.byKind[kind]   →  every node of this kind
 *   sections[kind]           →  the default design-system renderer
 *
 * Returns `null` when no renderer is registered for the node's kind, letting the
 * engine skip it. This is the seam where a page registers bespoke UI (a sticker
 * sheet, a special feature card) without the engine learning about it.
 */
export function resolveRenderer<TProps = JsonValue>(
  node: PageNode,
  sections: Registry<TProps>,
  overrides: Option<RendererOverrides<TProps>>,
): Option<NodeRenderer<TProps>> {
  const byId = overrides?.byId?.[node.id];
  if (byId) return byId;

  const byKind = overrides?.byKind?.[node.kind];
  if (byKind) return byKind;

  return sections[node.kind] ?? null;
}
