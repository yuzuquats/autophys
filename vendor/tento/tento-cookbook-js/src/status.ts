/** The sidebar status line. The default source is a server's GET /api/healthz
 * returning {ok, version, commit}. */
export type StatusLine = { tone: "ok" | "down" | "pending"; text: string };
export type Health = { ok: boolean; version: string; commit: string };

export function parseHealth(value: unknown): Health | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, version, commit } = value as Record<string, unknown>;
  if (typeof ok !== "boolean" || typeof version !== "string" || typeof commit !== "string") return null;
  return { ok, version, commit };
}

export function describeHealth(health: Health | null): StatusLine {
  if (!health) return { tone: "down", text: "Server unreachable" };
  if (!health.ok) return { tone: "down", text: `Server not ready · ${health.version}` };
  return { tone: "ok", text: `Server ok · ${health.version} · ${health.commit.slice(0, 7)}` };
}

export async function readHealthz(url = "/api/healthz", fetcher: typeof fetch = fetch): Promise<StatusLine> {
  try {
    const response = await fetcher(url, { headers: { accept: "application/json" } });
    return describeHealth(response.ok ? parseHealth(await response.json()) : null);
  } catch {
    return describeHealth(null);
  }
}
