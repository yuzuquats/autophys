let _canAdoptStylesheetCached: Option<boolean>;
function _canAdoptStylesheet(): boolean {
  if (_canAdoptStylesheetCached != null) return _canAdoptStylesheetCached;
  try {
    new CSSStyleSheet();
  } catch (_) {
    return (_canAdoptStylesheetCached = false);
  }
  return (_canAdoptStylesheetCached = true);
}

/**
 * A constructable sheet (or a `<style>` where sheets cannot be adopted) from
 * `s`. As a tag it takes no `${}` values: the sheet is built from the
 * template's literal strings, so a value would be dropped. Its one parameter
 * is what makes tsc refuse an interpolation (TS2554; pinned by
 * `component-styles.types.ts`): build the string first and call `css(text)`.
 */
export const css = (s: TemplateStringsArray | string): Style.Compat => {
  if (globalThis["disable-dom"] || typeof document === "undefined") {
    return null as unknown as Style.Compat;
  }

  if (_canAdoptStylesheet()) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${s}`);
    return sheet;
  }

  return Style.make(s.toString());
};

export namespace Style {
  export type Compat = HTMLStyleElement | CSSStyleSheet;

  export const canAdoptStylesheet = _canAdoptStylesheet;

  export function make(style: string): HTMLStyleElement {
    const $style = document.createElement("style");
    $style.textContent = style;
    return $style;
  }

  const cache: Map<Compat, HTMLStyleElement> = new Map();
  export function makeWith(s: Compat): HTMLStyleElement {
    if (s instanceof HTMLStyleElement) {
      return s.cloneNode(true) as HTMLStyleElement;
    }
    const $cached = cache.get(s);
    if ($cached) {
      return $cached.cloneNode(true) as HTMLStyleElement;
    }
    const style = [...s.cssRules].map((r) => r.cssText).join("\n");
    const $template = make(style);
    cache.set(s, $template);
    return $template.cloneNode(true) as HTMLStyleElement;
  }

  export const borderBoxStyle = /* css */ `
    * {
      box-sizing: border-box;
    }
  `;
  export const $borderBoxStyle = css(borderBoxStyle);
}
