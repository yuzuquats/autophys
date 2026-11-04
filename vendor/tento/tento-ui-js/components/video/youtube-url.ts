export interface YoutubeUrl {
  url: URL;
}

export namespace YoutubeUrl {
  /**
   * Valid YouTube host domains
   */
  export const VALID_HOSTS = new Set([
    "www.youtube.com",
    "youtube.com",
    "m.youtube.com",
    "youtu.be",
  ]);

  const VALID_HOSTS_ARRAY = [
    "www.youtube.com",
    "youtube.com",
    "m.youtube.com",
    "youtu.be",
  ];

  /**
   * Checks if a partial or complete URL string could potentially be a valid YouTube URL.
   * This function uses prefix matching to avoid showing validation errors while the user
   * is still typing a valid YouTube URL.
   *
   * @param text - The URL string to validate (can be partial or complete)
   * @returns true if the text could be a valid YouTube URL, false otherwise
   *
   * @example
   * YoutubeUrl.couldBeValid("yout") // true - could become "youtube.com"
   * YoutubeUrl.couldBeValid("https://y") // true - could become "https://youtube.com"
   * YoutubeUrl.couldBeValid("face") // false - cannot become a YouTube URL
   * YoutubeUrl.couldBeValid("https://vimeo.com") // false - valid URL but not YouTube
   */
  export function couldBeValid(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return true;

    const url = URL.parse(trimmed);
    if (url && VALID_HOSTS.has(url.host)) {
      return true;
    }

    let withoutProtocol = trimmed;
    if (trimmed.startsWith("https://")) {
      withoutProtocol = trimmed.substring(8);
    } else if (trimmed.startsWith("http://")) {
      withoutProtocol = trimmed.substring(7);
    }

    if ("https://".startsWith(trimmed) || "http://".startsWith(trimmed)) {
      return true;
    }

    for (const host of VALID_HOSTS_ARRAY) {
      if (host.startsWith(withoutProtocol)) {
        return true;
      }
      if (("https://" + host).startsWith(trimmed)) {
        return true;
      }
      if (("http://" + host).startsWith(trimmed)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Parses a string and returns a YoutubeUrl if it's a valid YouTube URL.
   *
   * @param s - The URL string to parse
   * @returns A YoutubeUrl instance if valid, null otherwise
   */
  export function parse(s: string): Option<YoutubeUrl> {
    const url = URL.parse(s);
    if (!url) return null;
    if (!VALID_HOSTS.has(url.host)) return null;
    return { url };
  }

  /**
   * Extracts the video ID from various YouTube URL formats.
   *
   * @param url - The YouTube URL string
   * @returns The video ID if found, null otherwise
   *
   * @example
   * extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ") // "dQw4w9WgXcQ"
   * extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ") // "dQw4w9WgXcQ"
   * extractVideoId("https://youtu.be/dQw4w9WgXcQ") // "dQw4w9WgXcQ"
   * extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ") // "dQw4w9WgXcQ"
   */
  export function extractVideoId(url: string): Option<string> {
    const urlObj = URL.parse(url);
    if (!urlObj) return null;

    if (urlObj.pathname.startsWith("/shorts/")) {
      const videoId = urlObj.pathname.split("/shorts/")[1]?.split("?")[0];
      return videoId ?? null;
    }

    if (urlObj.pathname === "/watch") {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      const videoId = urlObj.pathname.substring(1).split("?")[0];
      return videoId || null;
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      const videoId = urlObj.pathname.split("/embed/")[1]?.split("?")[0];
      return videoId ?? null;
    }

    return null;
  }

  /**
   * Normalizes a YouTube URL to the standard watch format.
   * Converts Shorts URLs, youtu.be URLs, and embed URLs to the standard format.
   *
   * @param url - The YouTube URL to normalize
   * @returns The normalized URL in watch format, or the original URL if video ID cannot be extracted
   *
   * @example
   * normalize("https://www.youtube.com/shorts/dQw4w9WgXcQ") // "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
   * normalize("https://youtu.be/dQw4w9WgXcQ") // "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
   */
  export function normalize(url: string): string {
    const videoId = extractVideoId(url);
    if (videoId == null) return url;
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
}
