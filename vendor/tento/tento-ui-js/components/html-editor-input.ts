/** Preserve HTML source whitespace; only plain text newlines are visible breaks. */
export function prepareEditorHtml(input: string): string {
  if (/<\/?[a-z][^>]*>/i.test(input)) return input;
  return input.replace(/&(?!#(?:[0-9]+|x[0-9a-f]+);|[a-z][a-z0-9]+;)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
}
