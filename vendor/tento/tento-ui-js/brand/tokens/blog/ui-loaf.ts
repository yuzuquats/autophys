import { css } from "../../../component-styles";
import { Typography } from "../../../ui/typography";

export const uiLoaf = css(`
  a {
    color: var(--text-pri);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }

  a:hover {
    color: var(--blue);
  }

  /* Transparent quote with a rounded-capped left bar. The bar is a ::before
     "decorator" so the border-radius lands on the line itself (a pill), not the
     blockquote box. The left padding lives in spacing/loaf.ts. */
  blockquote {
    position: relative;
  }

  blockquote::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--blue) 58%, var(--bg-elevated) 42%);
  }

  /* Italic quote text (the loaf typography token sets blockquote to normal). */
  std-rich-text-editor blockquote {
    font-style: italic;
  }

  /* Code rendering mirrors std-documentation (components/documentation), adapted
     to lona tokens: loaf has no --bg-surface, so the raised --bg-elevated card is
     given a 1px --divider border (as the search input / list rows are) to read
     crisply on the beige page. Typography.codeBlockRule supplies the monospace
     family + baseline-capheight sizing from --font-size / --line-height-ratio. */
  code {
    ${Typography.codeBlockRule}
    --font-size: var(--text-9px);
    background: var(--bg-elevated);
    border: 1px solid var(--divider);
    border-radius: 4px;
    padding: 1px 5px;
    color: var(--text-pri);
    white-space: break-spaces;
    overflow-wrap: anywhere;
    /* When an inline-code span wraps, give each line fragment its own padded,
       rounded, bordered box instead of tearing one box across the break. */
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }

  pre {
    ${Typography.codeBlockRule}
    --font-size: var(--text-9px);
    --line-height-ratio: 1.4;
    background: var(--bg-elevated);
    border: 1px solid var(--divider);
    border-radius: 8px;
    padding: 12px 14px;
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    margin-block: 24px;
  }

  pre code {
    display: block;
    background: transparent;
    border: none;
    border-radius: 0px;
    padding: 0px;
    white-space: pre;
    overflow-wrap: normal;
  }

  /* Fenced code blocks render via std-code (CodeMirror/Lezer highlighting); it
     brings its own border-radius + --bg-surface fill (see color/loaf.ts), but
     needs a divider border to read as a crisp card on the beige page. */
  std-code {
    border: 1px solid var(--divider);
  }

  /* Post-body images: scale to the content width and round the corners. Scoped
     to the editor so the squircle-clipped hero image is unaffected. */
  std-rich-text-editor img {
    display: block;
    max-width: 100%;
    height: auto;
    border-radius: 12px;
  }

  /* Tables (rich markdown serde). Cells sit outside the baseline-capheight
     typography system, so a direct font-size is used (as std-documentation does).
     Scoped to the post body so blog-list tables are unaffected. */
  std-rich-text-editor table {
    width: 100%;
    border-collapse: collapse;
    margin-block: 24px;
  }

  std-rich-text-editor th,
  std-rich-text-editor td {
    /* Below body paragraphs (--p-size = --text-12px): tabular data reads fine
       smaller. Same baseline-capheight scaling Typography applies to <p> (cells
       aren't in its selector list). */
    font-size: calc(var(--text-10px) / (1 - var(--cap-height) - var(--baseline)));
    padding: 10px 16px;
    text-align: left;
    border-bottom: 1px solid var(--divider);
  }

  std-rich-text-editor th {
    color: var(--text-pri);
    font-weight: 600;
  }

  std-rich-text-editor td {
    color: var(--text-sec);
  }

  /* Task lists (GFM "- [ ] / - [x]"): drop the bullet; style the native input
     like the Lona round checkbox (std-checkbox) — circular, --divider border,
     --blue fill + white check when checked. */
  std-rich-text-editor .task-list-item {
    list-style: none;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 12px;
  }

  std-rich-text-editor .task-list-item input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    flex: none;
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    margin: 4px 0 0;
    border: 2px solid var(--divider);
    border-radius: 50%;
    background: var(--bg);
    position: relative;
    cursor: default;
  }

  /* Checked: blue fill + the Lona CheckmarkIcon (icons/checkmark.svg) in white,
     centered — matches std-checkbox's round variant. */
  std-rich-text-editor .task-list-item input[type="checkbox"]:checked {
    background-color: var(--blue);
    border-color: var(--blue);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23fff'%3E%3Cpath d='M18.71,7.21a1,1,0,0,0-1.42,0L9.84,14.67,6.71,11.53A1,1,0,1,0,5.29,13l3.84,3.84a1,1,0,0,0,1.42,0l8.16-8.16A1,1,0,0,0,18.71,7.21Z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 14px;
  }

  std-rich-text-editor .task-item-body {
    flex: 1;
  }

  /* Drop the paragraph's baseline-capheight negative top margin so the first
     line sits level with the checkbox; collapse trailing margin to stay tight. */
  std-rich-text-editor .task-item-body > :first-child {
    margin-top: 0 !important;
  }

  std-rich-text-editor .task-item-body > :last-child {
    margin-bottom: 0 !important;
  }

  /* Symmetric block padding for body prose (top-level only) — equal space above
     and below each paragraph, instead of a bottom-only margin. */
  std-rich-text-editor .ProseMirror > p {
    --margin-top: 0px;
    --margin-bottom: 0px;
    padding-block: 17px;
  }

  std-rich-text-editor .ProseMirror > h4 {
    --margin-top: 40px;
    --margin-bottom: 24px;
  }

  .hero {
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--bg) 88%, var(--green-dimmed) 12%) 0%,
        var(--bg) 100%
      );
  }

  .hero-title {
    color: var(--text-pri);
  }

  .hero-subtitle {
    color: var(--text-sec);
  }

  /* Hero shares the post-list date-rail grid so "Blog"/subtitle land in the same
     content column as the titles. Tokens come from BlogListPagelet :host. */
  .hero-container {
    width: 100%;
    max-width: var(--blog-content-max, 860px);
    margin: 0 auto;
    display: grid;
    grid-template-columns: var(--blog-date-col, 100px) 1fr;
    column-gap: var(--blog-rail-gap, 32px);
  }

  .hero-content {
    grid-column: 2;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* On mobile the rows collapse to a single column (date over title); the hero
     collapses the same way so its text stays flush-left and aligned. */
  @media (max-width: 768px) {
    .hero-container {
      grid-template-columns: 1fr;
    }

    .hero-content {
      grid-column: 1;
    }
  }

  std-blog-search-filter-bar {
    background: var(--bg);
  }

  .search-input,
  #search-input {
    color: var(--text-sec);
  }

  .filter-pill {
    color: var(--text-ter);
  }

  .filter-pill.active,
  .filter-pill:hover {
    color: var(--text-pri);
  }

  .simple-row {
    border-color: var(--divider);
  }

  .simple-row:hover {
    background: var(--bg-hover);
  }

  .simple-title {
    color: var(--text-pri);
  }

  .simple-snippet {
    color: var(--text-sec);
  }

  .tag {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border: 1px solid var(--divider);
    border-radius: 999px;
    background: var(--bg-surface-light);
    color: var(--text-sec);
  }

  .blog-post-title {
    font-weight: 560;
  }
`);
