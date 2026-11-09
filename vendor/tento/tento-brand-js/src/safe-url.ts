/** Mirror markdown::safe_url for links in structured page content. */
export function safeUrl(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(value)) return false;
  const first = value.trim().split(/[/?#]/)[0];
  const colon = first.indexOf(":");
  return colon < 0 || ["http", "https", "mailto"].includes(first.slice(0, colon).toLowerCase());
}

export function setSafeHref(
  element: Pick<HTMLAnchorElement, "setAttribute" | "removeAttribute">,
  value: string,
): void {
  if (safeUrl(value)) element.setAttribute("href", value);
  else element.removeAttribute("href");
}
