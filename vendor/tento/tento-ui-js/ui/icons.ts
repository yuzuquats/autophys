import { html } from "../component";
import { Div } from "../component-builtin";
import { replaceAll } from "@tento-core/polyfill";
import { Utils } from "../utils";

export namespace LonaIcons {
  export type RawSvg = string;

  export type Props = Optional<{
    margin: string;
    color: string;
    sizePx: number;
  }>;

  export function make(svgString: RawSvg, options?: Props): HTMLElement {
    const $e = Div.make();
    const $s = $svg(svgString);
    $e.appendChild($s);
    $e.style.display = "flex";
    $e.style.alignItems = "stretch";
    $e.style.justifyContent = "stretch";
    const sizePx = (options?.sizePx ?? 16) + "px";
    $e.style.height = sizePx;
    $e.style.width = sizePx;
    $e.style.color = options?.color ?? "var(--fg-icon-sec)";
    options?.margin && ($e.style.margin = options.margin);
    return $e;
  }

  export function $svg(svgString: RawSvg): SVGElement {
    const fragment = $template(svgString).content.cloneNode(
      true,
    ) as DocumentFragment;
    // Was an unchecked cast straight into `$svg.slot = "icon"`, so a string
    // that did not parse as markup failed with "Cannot set properties of
    // null", naming neither the source nor the caller.
    const $svg = fragment.firstElementChild as Option<SVGElement>;
    if ($svg == null) throw invalidSvgSource(svgString);
    $svg.slot = "icon";
    return $svg;
  }

  function invalidSvgSource(source: string): Error {
    return new Error(
      `LonaIcons.$svg: not SVG markup (${source.length} chars starting "${source.slice(0, 24)}")`,
    );
  }

  export const $template: (svgString: RawSvg) => HTMLTemplateElement =
    Utils.memoize(html);

  export function symbol(svgString: RawSvg): string {
    return replaceAll(svgString, "svg", "symbol");
  }
}

// Re-export all icon exports for backwards compatibility
export * from "../icon-exports";
