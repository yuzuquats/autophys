import { css } from "../../component-styles";
import { Storybook } from "../../ui/storybook";
import { ThemeContext } from "./theme-context";
import { RichTextEditor } from "../rich-text-editor/rich-text-editor";

const TEST_MARKDOWN = `
# Heading

**Bold text** and *italic text*

- bullet one
- bullet two

> A blockquote
`;

const COMPACT_STYLE = css`
  ::slotted(*) {
    --h1-size: var(--text-14px);
    --h2-size: var(--text-14px);
    --h3-size: var(--text-14px);
    --p-size: var(--text-12px);
  }

  p {
    --margin-top: 0px;
    --margin-bottom: 4px;
  }

  h1, h2, h3, h4, h5, h6 {
    --margin-top: 4px;
    --margin-bottom: 4px;
  }
`;

const LARGE_STYLE = css`
  ::slotted(*) {
    --h1-size: var(--h2-size);
    --p-size: var(--text-16px);
  }

  p {
    --margin-top: 0px;
    --margin-bottom: 24px;
  }

  h1 {
    --margin-top: 24px;
    --margin-bottom: 24px;
  }
`;

export class ThemeContextStoryBook extends Storybook.Default {
  title(): string {
    return "Theme Context";
  }

  tags(): string[] {
    return ["std-theme-context"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default (no theme)",
        render: () => {
          const $editor = RichTextEditor.make();
          $editor.assignStyles({
            height: "200px",
            width: "280px",
            borderRadius: "8px",
            padding: "12px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({ markdown: TEST_MARKDOWN });
          return $editor;
        },
      },
      {
        title: "Compact typography",
        render: () => {
          const $ctx = ThemeContext.make();
          $ctx.bind({ styles: [COMPACT_STYLE] });

          const $editor = RichTextEditor.make();
          $editor.assignStyles({
            height: "200px",
            width: "280px",
            borderRadius: "8px",
            padding: "12px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({ markdown: TEST_MARKDOWN });

          $ctx.appendChild($editor);
          return $ctx;
        },
      },
      {
        title: "Large typography",
        render: () => {
          const $ctx = ThemeContext.make();
          $ctx.bind({ styles: [LARGE_STYLE] });

          const $editor = RichTextEditor.make();
          $editor.assignStyles({
            height: "280px",
            width: "320px",
            borderRadius: "8px",
            padding: "16px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({ markdown: TEST_MARKDOWN });

          $ctx.appendChild($editor);
          return $ctx;
        },
      },
    ];
  }
}
