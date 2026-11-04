import { assertStrictEquals } from "jsr:@std/assert";

import type {
  NodeRenderer,
  Registry,
  RendererOverrides,
} from "./page-engine.types.ts";
import type { PageNode } from "./page-model.ts";
import { resolveRenderer } from "./renderer-resolution.ts";

type Props = { node: PageNode };

function stub(label: string): NodeRenderer<Props> {
  return {
    make(): HTMLElement {
      throw new Error(`stub renderer "${label}" should not render in this test`);
    },
    bind(instance: HTMLElement): HTMLElement {
      return instance;
    },
    skeleton: null,
  };
}

function node(kind: PageNode["kind"], id: string): PageNode {
  return { kind, id, props: {}, children: null };
}

const defaultCard = stub("default-card");
const sections: Registry<Props> = { card: defaultCard };

Deno.test("resolveRenderer falls back to the section set when no overrides", () => {
  const renderer = resolveRenderer(node("card", "any"), sections, null);
  assertStrictEquals(renderer, defaultCard);
});

Deno.test("resolveRenderer returns null for an unregistered kind", () => {
  const renderer = resolveRenderer(node("pricing", "any"), sections, null);
  assertStrictEquals(renderer, null);
});

Deno.test("resolveRenderer prefers byKind over the section set", () => {
  const kindOverride = stub("kind-override");
  const overrides: RendererOverrides<Props> = {
    byId: null,
    byKind: { card: kindOverride },
  };
  const renderer = resolveRenderer(node("card", "x"), sections, overrides);
  assertStrictEquals(renderer, kindOverride);
});

Deno.test("resolveRenderer prefers byId over byKind and the section set", () => {
  const kindOverride = stub("kind-override");
  const idOverride = stub("id-override");
  const overrides: RendererOverrides<Props> = {
    byId: { "landing.features.stickers": idOverride },
    byKind: { card: kindOverride },
  };

  const sticker = resolveRenderer(
    node("card", "landing.features.stickers"),
    sections,
    overrides,
  );
  assertStrictEquals(sticker, idOverride);

  const otherCard = resolveRenderer(node("card", "other"), sections, overrides);
  assertStrictEquals(otherCard, kindOverride);
});
