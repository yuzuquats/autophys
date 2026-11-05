/** Existing node ids can be bookmarked as #id or ?selection=id (?select=id also accepted). */
export function selectionAddress(search: string, hash: string): string | null {
  const query = new URLSearchParams(search);
  const raw = hash.replace(/^#\/?/, "") || query.get("selection") || query.get("select");
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
}
