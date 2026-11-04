import { Storybook } from "../../ui/storybook";
import { RichTextEditor } from "./rich-text-editor";

const TEST_MARKDOWN = `
# h1 Heading
## h2 Heading
### h3 Heading

**Bold text** and *italic text*

- bullet one
- bullet two

> A blockquote

Inline \`code\` example
`;

export class RichTextEditorStoryBook extends Storybook.Default {
  title(): string {
    return "Rich Text Editor (Light DOM)";
  }

  tags(): string[] {
    return ["std-rich-text-editor"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Empty with placeholder",
        render: () => {
          const $editor = RichTextEditor.make();
          $editor.assignStyles({
            height: "200px",
            width: "280px",
            borderRadius: "8px",
            padding: "12px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({
            placeholder: "Start typing...",
          });
          return $editor;
        },
      },
      {
        title: "Pre-filled markdown",
        render: () => {
          const $editor = RichTextEditor.make();
          $editor.assignStyles({
            height: "200px",
            width: "280px",
            borderRadius: "8px",
            padding: "12px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({
            markdown: TEST_MARKDOWN,
          });
          return $editor;
        },
      },
      {
        title: "Read-only",
        render: () => {
          const $editor = RichTextEditor.make();
          $editor.assignStyles({
            height: "200px",
            width: "280px",
            borderRadius: "8px",
            padding: "12px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({
            markdown: TEST_MARKDOWN,
            editable: false,
          });
          return $editor;
        },
      },
      {
        title: "Caller-styled (light DOM)",
        render: () => {
          const $wrapper = document.createElement("div");
          $wrapper.style.width = "320px";

          const $style = document.createElement("style");
          $style.textContent = `
            .styled-editor .ProseMirror h1 {
              color: var(--blue);
              --font-size: var(--h3-size);
            }
            .styled-editor .ProseMirror blockquote {
              border-left: 3px solid var(--blue);
              padding-left: 12px;
              color: var(--text-ter);
            }
          `;
          $wrapper.appendChild($style);

          const $editor = RichTextEditor.make();
          $editor.classList.add("styled-editor");
          $editor.assignStyles({
            height: "200px",
            borderRadius: "8px",
            padding: "12px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({
            markdown: TEST_MARKDOWN,
          });
          $wrapper.appendChild($editor);
          return $wrapper;
        },
      },
    ];
  }
}
