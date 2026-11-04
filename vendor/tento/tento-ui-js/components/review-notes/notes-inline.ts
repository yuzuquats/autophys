// Mini inline formatter for text inside review-note components (callout
// bodies, step descriptions): backtick code spans and **bold** only — enough
// for teaching prose, small enough to stay obviously safe. Everything goes
// through textContent; no markup from note content ever reaches innerHTML.

export namespace NotesInline {
  export function $format(text: string): HTMLElement {
    const $span = document.createElement("span");
    // Split on `code` and **bold** runs, keeping the delimiters' content.
    const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) {
        $span.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const token = m[0];
      if (token.startsWith("`")) {
        const $code = document.createElement("code");
        $code.textContent = token.slice(1, -1);
        $span.appendChild($code);
      } else {
        const $b = document.createElement("b");
        $b.textContent = token.slice(2, -2);
        $span.appendChild($b);
      }
      last = m.index + token.length;
    }
    if (last < text.length) {
      $span.appendChild(document.createTextNode(text.slice(last)));
    }
    return $span;
  }
}
