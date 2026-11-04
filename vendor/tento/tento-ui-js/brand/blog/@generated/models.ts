export interface BlogPostSummary {
  authorName: string;
  authorRole?: Option<string>;
  category: string;
  date: string;
  featured: boolean;
  heroImage: string;
  slug: string;
  summary: string;
  tags: string[];
  title: string;
}
export namespace BlogPostSummary {
  export function parse(raw: UntypedJson): BlogPostSummary {
    return raw;
  }
}
export interface BlogListResponse {
  posts: BlogPostSummary[];
}
export namespace BlogListResponse {
  export function parse(raw: UntypedJson): BlogListResponse {
    raw.posts && (raw.posts = raw.posts.map(BlogPostSummary.parse));
    return raw;
  }
}
export interface BlogPostDetail {
  authorName: string;
  authorRole?: Option<string>;
  category: string;
  content: string;
  contentHtml: string;
  date: string;
  featured: boolean;
  heroImage: string;
  slug: string;
  summary: string;
  tags: string[];
  title: string;
}
export namespace BlogPostDetail {
  export function parse(raw: UntypedJson): BlogPostDetail {
    return raw;
  }
}
