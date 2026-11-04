/** Display the actual meeting provider; the calendar fallback is for new links only. */
export function conferenceOrigin(data: unknown, newLinkProvider: string | null): string | null {
  if (data == null) return newLinkProvider;
  if (typeof data !== "object" || Array.isArray(data)) return null;
  const conference = data as Record<string, unknown>;
  const solution = conference.conferenceSolution;
  if (solution != null && typeof solution === "object" && !Array.isArray(solution)) {
    const name = (solution as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  if (!Array.isArray(conference.entryPoints)) return null;
  for (const entry of conference.entryPoints) {
    if (entry == null || typeof entry !== "object" || entry.entryPointType !== "video") continue;
    if (typeof entry.uri !== "string") continue;
    try {
      const url = new URL(entry.uri);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const host = url.hostname;
      const within = (domain: string) => host === domain || host.endsWith("." + domain);
      if (host === "meet.google.com") return "Google Meet";
      if (within("zoom.us") || within("zoom.com")) return "Zoom";
      if (host === "teams.microsoft.com" || host === "teams.live.com" || host === "teams.cloud.microsoft") return "Microsoft Teams";
      if (within("webex.com")) return "Webex";
      return host;
    } catch {
      // Ignore unusable entries instead of attributing them to the calendar's provider.
    }
  }
  return null;
}
