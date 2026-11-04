import type { BlogPost } from "./blog-types";

export type BlogMatchSnippet = {
  label: string;
  text: string;
};

export namespace BlogSearchHighlight {
  const QUERY_TERMS_CACHE_LIMIT = 200;
  const queryTermsCache = new Map<string, string[]>();

  export function queryTerms(query: string): string[] {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return [];

    const cached = queryTermsCache.get(normalized);
    if (cached) return cached;

    const terms = normalized
      .trim()
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .filter((term, index, arr) => arr.indexOf(term) === index);

    queryTermsCache.set(normalized, terms);
    if (queryTermsCache.size > QUERY_TERMS_CACHE_LIMIT) {
      const oldest = queryTermsCache.keys().next().value;
      if (oldest) {
        queryTermsCache.delete(oldest);
      }
    }

    return terms;
  }

  export function applyHighlightedText(
    $element: HTMLElement,
    text: string,
    query: string,
  ): void {
    $element.textContent = "";

    const terms = queryTerms(query);
    if (terms.length === 0 || text.length === 0) {
      $element.textContent = text;
      return;
    }

    const ranges = collectRanges(text, terms);
    if (ranges.length === 0) {
      $element.textContent = text;
      return;
    }

    let cursor = 0;
    for (const range of ranges) {
      if (range.start > cursor) {
        $element.appendChild(
          document.createTextNode(text.slice(cursor, range.start)),
        );
      }

      const $mark = document.createElement("mark");
      $mark.textContent = text.slice(range.start, range.end);
      $element.appendChild($mark);
      cursor = range.end;
    }

    if (cursor < text.length) {
      $element.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  export function findSnippet(
    post: BlogPost,
    query: string,
  ): Option<BlogMatchSnippet> {
    const terms = queryTerms(query);
    if (terms.length === 0) return null;

    const candidates: BlogMatchSnippet[] = [
      { label: "Summary", text: post.summary },
      { label: "Author", text: post.authorName ?? "" },
      { label: "Category", text: post.category ?? "" },
      { label: "Tags", text: (post.tags ?? []).join(", ") },
    ];

    for (const candidate of candidates) {
      const lower = candidate.text.toLowerCase();
      if (terms.some((term) => lower.includes(term))) {
        return candidate;
      }
    }

    return null;
  }

  function collectRanges(text: string, terms: string[]): Range[] {
    const lower = text.toLowerCase();
    const ranges: Range[] = [];

    for (const term of terms) {
      let index = lower.indexOf(term);
      while (index !== -1) {
        ranges.push({ start: index, end: index + term.length });
        index = lower.indexOf(term, index + term.length);
      }
    }

    if (ranges.length === 0) return [];
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);

    const merged: Range[] = [];
    for (const range of ranges) {
      const prev = merged[merged.length - 1];
      if (!prev || range.start > prev.end) {
        merged.push({ ...range });
        continue;
      }
      prev.end = Math.max(prev.end, range.end);
    }
    return merged;
  }
}

type Range = {
  start: number;
  end: number;
};
