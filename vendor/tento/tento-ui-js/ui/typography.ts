import { css } from "../component-styles";

export namespace Typography {
  export type Tag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "caption";
  export type Size = Tag | "small";

  /* The app's monospace face, in one place. Every mono surface must reach for
   * THIS and not spell a stack of its own — the review surface spells
   * `var(--mono, monospace)` at 27 sites and `--mono` is defined nowhere, so
   * all 27 silently ship the browser's generic `monospace` while the code
   * spans two components over render SF Mono. A `var(--token, literal)` whose
   * token does not exist is not a fallback, it is the value.
   *
   * Interpolating this into a `css` TAGGED template drops it (the tag form
   * ignores interpolations) — use the `css(`…`)` call form. */
  export const MONO_STACK = `"SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace`;

  export function text(
    text: string,
    options?: Optional<{
      tag: Tag;
      size: Size;
    }>,
  ): HTMLElement {
    const $text = document.createElement(
      options?.tag ?? tagFromSize(options?.size),
    );
    options?.size && $text.classList.add(options?.size);
    $text.textContent = text;
    return $text;
  }

  function tagFromSize(size?: Option<Size>): Tag {
    if (!size || size === "small") return "p";
    return size;
  }

  export const h1 = (t: string, size?: Option<Size>) =>
    text(t, { tag: "h1", size });
  export const h2 = (t: string, size?: Option<Size>) =>
    text(t, { tag: "h2", size });
  export const h3 = (t: string, size?: Option<Size>) =>
    text(t, { tag: "h3", size });
  export const h4 = (t: string, size?: Option<Size>) =>
    text(t, { tag: "h4", size });
  export const h5 = (t: string, size?: Option<Size>) =>
    text(t, { tag: "h5", size });
  export const h6 = (t: string, size?: Option<Size>) =>
    text(t, { tag: "h6", size });
  export const p = (t: string, size?: Option<Size>) =>
    text(t, { tag: "p", size });
  export const caption = (t: string, size?: Option<Size>) =>
    text(t, { tag: "caption", size });
  export const small = (t: string, size?: Option<Size>) =>
    text(t, { size: size ?? "small" });

  /*
   * Block-level code typography. Code lines stack inside the block, so the
   * negative cap-height/baseline trim from the text rule below must not
   * apply — only the cap-height font-size scaling does. Consumers declare
   * the inputs (--font-size, --line-height-ratio) and opt in with the
   * .code-block class, or splice this snippet into an element selector.
   */
  /* prettier-ignore */
  export const codeBlockRule = /* css */ `
    --font-height: calc(1 - var(--cap-height) - var(--baseline));
    --rfont-size: calc(var(--font-size) / var(--font-height));
    --rline-height: calc(var(--rfont-size) * var(--line-height-ratio, 1.00));
    font-family: ${MONO_STACK};
    font-size: var(--rfont-size);
    line-height: var(--rline-height);
  `;

  /* prettier-ignore */
  export const style = /* css */ `
    .code-block {
      ${codeBlockRule}
    }

    .spanned-typography span,
    std-text, .text,
    *[placeholder]::before,
    button[text], .button[text],
    a, .a,
    .h1, .h2, .h3, .h4, .h5, .h6, .h7, .p, .ul, .ol, .caption, caption, .label,
    h1, h2, h3, h4, h5, h6, h7, p, ul, ol, std-caption, .small, .text, label {
      --font-height: calc(1 - var(--cap-height) - var(--baseline));
      --rfont-size: calc(var(--font-size) / var(--font-height));
      --line-height-offset: calc((var(--line-height-ratio, 1.00) - 1) * var(--rfont-size) / 2);
      --rmargin-top:
        calc(
          -1 * var(--cap-height) * var(--rfont-size)
          - var(--line-height-offset)
          + var(--margin-top, 0px));
      --rmargin-bottom:
        calc(
          -1 * var(--baseline) * var(--rfont-size)
          - var(--line-height-offset)
          + var(--margin-bottom, 0px));

      font-weight: 400;
      font-size: var(--rfont-size);
      line-height: calc(var(--rfont-size) * var(--line-height-ratio, 1.00));
      margin: 0;
      padding: 0;
      margin-top: var(--rmargin-top);
      margin-bottom: var(--rmargin-bottom);
      min-height: var(--font-size);
    }

    /* Section spacing belongs to document surfaces and component callers. */
    .headline { --font-size: var(--headline-size) }
    .h1, h1 { --font-size: var(--h1-size); --line-height-ratio: 1.1; }
    .h2, h2 { --font-size: var(--h2-size); --line-height-ratio: 1.1; }
    .h3, h3 { --font-size: var(--h3-size); --line-height-ratio: 1.1; }
    .h4, h4 { --font-size: var(--h4-size); --line-height-ratio: 1.2; }
    .h5, h5 { --font-size: var(--h5-size); --line-height-ratio: 1.2; }
    .h6, h6 { --font-size: var(--h6-size); --line-height-ratio: 1.2; }
    .h7, h7 { --font-size: var(--h7-size); --line-height-ratio: 1.2; }
    a, .a, .p, .ul, .ol, p, ul, ol { --font-size: var(--p-size); --line-height-ratio: var(--body-line-height-ratio, 1.6); }
    /* Heading emphasis is opt-in, independent of semantic level or size. */
    h1, h2, h3, .h1, .h2, .h3 { font-weight: var(--heading-weight, 400); }
    /* Explicit reading-surface opt-in; editors and text cells stay regular. */
    .prose-headings :is(h1, h2, h3, h4, h5, h6) {
      font-weight: var(--heading-weight, 600);
    }

    /* Opt-in prose rhythm. Low specificity leaves document/caller styles in charge. */
    :where(.prose-spacing) :is(h1, h2, h3) {
      --margin-top: 24px;
      --margin-bottom: 12px;
    }
    :where(.prose-spacing) :is(h4, h5, h6) {
      --margin-top: 20px;
      --margin-bottom: 8px;
    }
    :where(.prose-spacing) :is(p, ul, ol) {
      --margin-top: 0px;
      --margin-bottom: 12px;
    }
    :where(.prose-spacing) :where(li) > p {
      --margin-bottom: 4px;
    }
    :where(.prose-spacing) > :is(h1, h2, h3, h4, h5, h6, p, ul, ol):first-child {
      --margin-top: 0px;
    }
    :where(.prose-spacing) > :is(h1, h2, h3, h4, h5, h6, p, ul, ol):last-child {
      --margin-bottom: 0px;
    }
    *[placeholder]::before { --font-size: var(--placeholder-size, var(--p-size)); }
    label, .label,
    .caption, std-caption { --font-size: var(--caption-size); --line-height-ratio: 1.1; }
    .small { --font-size: var(--small-size); --line-height-ratio: 1.1; }

    input::placeholder {
      color: var(--text-ter);
    }
  `;

  export const $style = css(style);

  /** The `.max-lines*` clamps as text (`$maxLines`), so a restating sheet can be compared to it. */
  export const maxLinesStyle = /* css */ `
    .max-lines {
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      overflow: hidden;
      -webkit-line-clamp: 2;
    }
    .max-lines-1 {
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      overflow: hidden;
      -webkit-line-clamp: 1;
    }
    .max-lines-2 {
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      overflow: hidden;
      -webkit-line-clamp: 2;
    }
    .max-lines-3 {
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      overflow: hidden;
      -webkit-line-clamp: 3;
    }
  `;

  export const $maxLines = css(maxLinesStyle);
  export const $noWrap = css`
    .no-wrap {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
}
