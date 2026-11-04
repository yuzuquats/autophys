import { EditDistance } from "./edit-distance";

export type SearchEntry = {
  name: string;
  priority: number;
  matchExact?: Option<string>;
  searchTerms: string[];
};

export type ScoredSearchEntry<T extends SearchEntry = SearchEntry> = {
  entry: T;
  score: number;
  matchedTerm?: Option<string>;
};

export type SearchMethod = "fuzzy" | "edit";

export type SearchOptions = {
  limit?: number;
  threshold?: number;
  method?: SearchMethod;
  defaultResults?: <T extends SearchEntry>(
    entries: T[],
  ) => ScoredSearchEntry<T>[];
};

export namespace Search {
  export function fuzzyScore(query: string, target: string): Option<number> {
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    // Quick exact substring check - heavily favor terms that contain the query as exact substring
    const exactSubstring = t.includes(q);
    if (exactSubstring) {
      // Prioritize if it's at the beginning of the string
      return t.startsWith(q) ? -100 : -90;
    }

    // If not an exact substring, try character-by-character fuzzy matching
    let qi = 0;
    let ti = 0;
    let firstMatch = -1;
    let lastMatch = -1;

    while (qi < q.length && ti < t.length) {
      if (q[qi] === t[ti]) {
        if (firstMatch === -1) firstMatch = ti;
        lastMatch = ti;
        qi++;
      }
      ti++;
    }

    if (qi !== q.length) return null;

    const matchLen = lastMatch - firstMatch + 1;
    let score = 0;

    if (firstMatch === 0) score -= 50;
    if (matchLen === q.length) score -= 20;
    score += matchLen;
    score += t.length / 10;

    return score;
  }

  export function editScore(query: string, target: string): Option<number> {
    if (!query || !target) return null;
    return EditDistance.distance(query, target);
  }

  /**
   * Default function to generate results when no query is provided
   */
  export function defaultResults<T extends SearchEntry>(
    entries: T[],
  ): ScoredSearchEntry<T>[] {
    return entries
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 2)
      .map((entry) => ({
        entry,
        score: 0,
      }));
  }

  /**
   * Unified search function that supports both fuzzy and edit distance methods
   */
  export function search<T extends SearchEntry>(
    query: Option<string>,
    entries: T[],
    options: SearchOptions = {},
  ): ScoredSearchEntry<T>[] {
    const {
      limit = 10,
      threshold,
      method = "fuzzy",
      defaultResults: getDefaultResults = defaultResults,
    } = options;

    // Handle empty query
    const sanitizedQuery = query?.toLowerCase().trim();
    if (!sanitizedQuery) {
      return getDefaultResults(entries);
    }

    const scoreFn = method === "fuzzy" ? fuzzyScore : editScore;
    const results: ScoredSearchEntry<T>[] = [];

    for (const entry of entries) {
      let bestScore: Option<number>;
      let matchedTerm: Option<string>;

      if (entry.matchExact != null) {
        if (query && entry.matchExact === query) {
          results.push({
            entry,
            score: -100,
            matchedTerm: entry.matchExact,
          });
        }
        continue;
      }

      // Try name first
      const nameScore = scoreFn(sanitizedQuery, entry.name.toLowerCase());
      if (nameScore != null) {
        bestScore = nameScore;
        matchedTerm = entry.name;
      }

      // Then try each search term
      for (const term of entry.searchTerms) {
        const score = scoreFn(sanitizedQuery, term.toLowerCase());
        if (!score) continue;
        if (bestScore == null || score < bestScore) {
          bestScore = score;
          matchedTerm = term;
        }
      }

      if (bestScore == null) continue;

      // Apply priority adjustment (lower priority number = higher priority)
      const priorityPenalty = entry.priority * (method === "fuzzy" ? 5 : 1);
      const adjustedScore =
        method === "fuzzy"
          ? bestScore + priorityPenalty // For fuzzy, lower score is better, so add penalty for higher priority numbers
          : bestScore + priorityPenalty; // For edit distance, same logic

      results.push({
        entry,
        score: adjustedScore,
        matchedTerm,
      });
    }

    // For fuzzy search lower is better, for edit distance lower is also better
    const sortedResults =
      method === "fuzzy"
        ? results.sort((a, b) => a.score - b.score)
        : results.sort((a, b) => a.score - b.score);

    if (threshold != null) {
      return sortedResults.filter(r => r.score <= threshold);
    }
    return sortedResults.slice(0, limit);
  }

  export function fuzzy<T extends SearchEntry>(
    query: string,
    entries: T[],
    limit?: number,
  ): ScoredSearchEntry<T>[] {
    return search(query, entries, { method: "fuzzy", limit });
  }

  export function edit<T extends SearchEntry>(
    query: string,
    entries: T[],
    limit?: number,
  ): ScoredSearchEntry<T>[] {
    return search(query, entries, { method: "edit", limit });
  }
}
