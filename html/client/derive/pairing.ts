/** A small presentation timeline: the browser advances labels without a view-owned clock.
 * Pairing lifetimes are minutes; coarse hour/day breakpoints also keep long deadlines bounded.
 */
export function pairingExpiry(at: string, now = Date.now()) {
  const end = Date.parse(at);
  if (!Number.isFinite(end)) return { at, steps: [{ label: "Expiry not recorded", delayMs: 0 }] };
  const points = new Set([now, Math.max(now, end)]);
  for (const [unit, count] of [[60_000, 60], [3_600_000, 24], [86_400_000, 30]]) {
    for (let i = 1; i <= count; i++) if (end - i * unit > now) points.add(end - i * unit);
  }
  const times = [...points].sort((a, b) => a - b);
  return { at, steps: times.map((time) => {
    const remaining = end - time;
    const label = remaining <= 0 ? "Code expired" : remaining <= 60_000 ? "Expires in <1 min"
      : remaining <= 3_600_000 ? `Expires in ${Math.ceil(remaining / 60_000)} min`
      : remaining <= 86_400_000 ? `Expires in ${Math.ceil(remaining / 3_600_000)} hr`
      : `Expires in ${Math.ceil(remaining / 86_400_000)} days`;
    return { label, delayMs: time - now };
  }) };
}
