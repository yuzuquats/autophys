/** The status line read from GET /api/healthz. */
export type Health = { ok: boolean; version: string; commit: string };
export type HealthLine = { tone: "ok" | "down"; text: string };

export function parseHealth(value: unknown): Health | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, version, commit } = value as Record<string, unknown>;
  if (typeof ok !== "boolean" || typeof version !== "string" || typeof commit !== "string") return null;
  return { ok, version, commit };
}

export function describeHealth(health: Health | null): HealthLine {
  if (!health) return { tone: "down", text: "Server unreachable" };
  if (!health.ok) return { tone: "down", text: `Server not ready · ${health.version}` };
  return { tone: "ok", text: `Server ok · ${health.version} · ${health.commit.slice(0, 7)}` };
}

export async function readHealth(fetcher: typeof fetch = fetch): Promise<HealthLine> {
  try {
    const response = await fetcher("/api/healthz", { headers: { accept: "application/json" } });
    return describeHealth(response.ok ? parseHealth(await response.json()) : null);
  } catch {
    return describeHealth(null);
  }
}
