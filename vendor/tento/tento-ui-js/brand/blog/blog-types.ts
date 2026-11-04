export type { BlogListResponse, BlogPostDetail, BlogPostSummary } from "./@generated/models";

// BlogPost: summary fields + optional detail-only fields for unified usage
export type BlogPost = {
  slug: string;
  title: string;
  date: string;
  summary: string;
  heroImage: string;
  authorName: string;
  authorRole?: Option<string>;
  category: string;
  featured: boolean;
  tags?: Option<string[]>;
  content?: Option<string>;
  contentHtml?: Option<string>;
};

export type CardLayout = "hero" | "featured" | "list";
