import { Storybook } from "../ui/storybook";
import { ProseMirrorEditor } from "./prosemirror";

const TEST_MARKDOWN = `
# h1 Heading
## h2 Heading
### h3 Heading
#### h4 Heading
##### h5 Heading
###### h6 Heading
___

- bullet
- bullet 2

**This is bold text**

__This is bold text__

*This is italic text*

_This is italic text_


> Blockquotes can also be nested...
>> ...by using additional greater-than signs right next to each other...
> > > ...or with spaces between arrows.

Inline \`code\`

Indented code

    // Some comments
    line 1 of code
    line 2 of code
    line 3 of code
`;

// ----- Not Implemented -----

// Strikethrough
// ~~Strikethrough~~

// ----- Broken -----

// Images
// ![Minion](https://octodex.github.com/images/minion.png)

export class ProseMirrorStoryBook extends Storybook.Default {
  title(): string {
    return "Prosemirror";
  }

  tags(): string[] {
    return ["std-prosemirror"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $editor = ProseMirrorEditor.make();
          $editor.assignStyles({
            height: "200px",
            width: "280px",
            borderRadius: "8px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({
            placeholder: "Add some text",
          });
          return $editor;
        },
      },
      {
        render: () => {
          const $editor = ProseMirrorEditor.make();
          $editor.assignStyles({
            height: "200px",
            width: "280px",
            borderRadius: "8px",
            background: "var(--bg-surface-light)",
          });
          $editor.bind({
            markdown: TEST_MARKDOWN,
          });
          return $editor;
        },
      },
      {
        // Lazy: static markup until pointer-down or focus builds the view.
        render: () => {
          const $editor = ProseMirrorEditor.make();
          $editor.assignStyles({ height: "200px", width: "280px", borderRadius: "8px", background: "var(--bg-surface-light)" });
          $editor.bind({ lazy: true, markdown: TEST_MARKDOWN });
          return $editor;
        },
      },
      {
        // Lazy and empty: the placeholder renders statically too.
        render: () => {
          const $editor = ProseMirrorEditor.make();
          $editor.assignStyles({ height: "80px", width: "280px", borderRadius: "8px", background: "var(--bg-surface-light)" });
          $editor.bind({ lazy: true, placeholder: "Click to write" });
          return $editor;
        },
      },
      {
        // Lazy and read-only: never activates; links open in a new tab.
        render: () => {
          const $editor = ProseMirrorEditor.make();
          $editor.assignStyles({ height: "120px", width: "280px", borderRadius: "8px", background: "var(--bg-surface-light)" });
          $editor.bind({ lazy: true, editable: false, markdown: "Read-only **static** text with a [link](https://lona.so)." });
          return $editor;
        },
      },
    ];
  }
}
