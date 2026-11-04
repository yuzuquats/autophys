// deno-lint-ignore-file no-namespace
// Mock LonaIcons namespace for Deno tests
export namespace LonaIcons {
  export type RawSvg = string;

  export type Props = Optional<{
    margin: string;
    color: string;
    sizePx: number;
  }>;

  export function make(_svgString: RawSvg, _options?: Props): any {
    return { style: {} };
  }

  export function $svg(_svgString: RawSvg): any {
    return { slot: "icon" };
  }

  export function $template(_svgString: RawSvg): any {
    return { content: { cloneNode: () => ({}) } };
  }

  export function symbol(svgString: RawSvg): string {
    return svgString.replace(/svg/g, "symbol");
  }
}

// Re-export all icon exports (mocks)
export * from "@tento-ui/icon-exports.deno.ts";
