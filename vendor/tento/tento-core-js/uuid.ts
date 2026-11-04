/**
 * A UUID string in its canonical hyphenated spelling (`8-4-4-4-12`), checked
 * only by shape. The namespace below merges with it: `Uuid.is`, `Uuid.parse`,
 * `Uuid.make`. A module type, so an importer does not need the workspace's
 * ambient `Uuid` (same definition, `types/uuid.d.ts`).
 */
export type Uuid = `${string}-${string}-${string}-${string}-${string}`;

export namespace Uuid {
  export function is(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      s
    );
  }

  /**
   * A wire id the schema declares `format: uuid`, taken as written: NOT
   * checked (ids minted by clients and older rows are not all UUIDs), so a
   * decoded `Uuid` is the server's word. Check with `is` where it matters.
   */
  export function parse(s: string): Uuid {
    return s as Uuid;
  }

  function v4(): Uuid {
    // @ts-ignore
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
      (
        c ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
      ).toString(16)
    );
  }

  export let make = v4;
  if (typeof crypto?.randomUUID === "function") {
    make = crypto.randomUUID.bind(crypto);
  }
}

export function isPrefixedUUID(s: string): boolean {
  const prefixIndex = s.indexOf("_");
  return Uuid.is(s.slice(prefixIndex + 1));
}
