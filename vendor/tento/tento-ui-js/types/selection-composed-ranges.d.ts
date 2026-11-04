/**
 * `Selection.getComposedRanges()` returns selection ranges that cross shadow
 * boundaries. It ships in Safari and Chromium but TypeScript's lib.dom does
 * not declare it yet, so a correct call reads as an error. Every call site in
 * this workspace already guards with `?.`, which is the right shape for an API
 * this new - the declaration is optional here for the same reason.
 */
interface StaticRangeLike {
  readonly startContainer: Node;
  readonly startOffset: number;
  readonly endContainer: Node;
  readonly endOffset: number;
  readonly collapsed: boolean;
}

interface Selection {
  getComposedRanges(options?: { shadowRoots?: ShadowRoot[] }): StaticRangeLike[];
}
