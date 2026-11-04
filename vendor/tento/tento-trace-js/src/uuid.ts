export namespace Uuid {
  export function is(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      s
    );
  }

  export function parse(s: string): string {
    return s;
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
