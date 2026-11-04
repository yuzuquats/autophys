import { Column } from "../../component-builtin";
import { Tracing } from "@tento-core/tracing";
import { Typography } from "../../ui/typography";
import { TextInputMenubar } from "./text-input-menubar";
import { HtmlEditor } from "../html-editor";
import { Storybook } from "../../ui/storybook";

export class TextInputMenubarStoryBook extends Storybook.Default {
  tags(): string[] {
    return ["std-text-input-menubar"];
  }

  title() {
    return "Text Input Menubar";
  }

  examples() {
    return [
      {
        title: "Menubar",
        render: () => {
          return Storybook.fill(TextInputMenubar.makeWith({
            onBold: () => Tracing.dev("Bold"),
            onItalic: () => Tracing.dev("Italic"),
            onUnderline: () => Tracing.dev("Underline"),
            onHeading: (level) => Tracing.dev(`Heading ${level}`),
            onList: (type) => Tracing.dev(`${type} list`),
            onLink: () => Tracing.dev("Link"),
            onCode: () => Tracing.dev("Code"),
            onClear: () => Tracing.dev("Clear"),
          }), "fit-content");
        },
      },
      {
        title: "Custom Button Groups",
        render: () => {
          return Storybook.fill(TextInputMenubar.makeWith({
            groups: [["bold", "italic"], ["h1", "h2"], ["bulletList"]],
            onBold: () => Tracing.dev("Bold"),
            onItalic: () => Tracing.dev("Italic"),
            onHeading: (level) => Tracing.dev(`Heading ${level}`),
            onList: (type) => Tracing.dev(`${type} list`),
          }), "fit-content");
        },
      },
      {
        title: "With Active States",
        render: () => {
          const $menubar = TextInputMenubar.makeWith({
            onBold: () => {
              // Toggle active state demo
              const currentState = $menubar.activeStates?.bold ?? false;
              $menubar.updateActiveStates({ bold: !currentState });
              console.log(`Bold: ${!currentState}`);
            },
            onItalic: () => Tracing.dev("Italic"),
            onUnderline: () => Tracing.dev("Underline"),
            activeStates: {
              bold: true,
              italic: false,
              underline: true,
            },
          });
          return Storybook.fill($menubar, "fit-content");
        },
      },
      {
        title: "Minimal Menubar",
        render: () => {
          return Storybook.fill(TextInputMenubar.makeWith({
            groups: [["bold", "italic", "underline"]],
            onBold: () => Tracing.dev("Bold"),
            onItalic: () => Tracing.dev("Italic"),
            onUnderline: () => Tracing.dev("Underline"),
          }), "fit-content");
        },
      },
      {
        title: "Connected to HTML Editor",
        render: async () => {
          const $container = Column.make();
          $container.style.gap = "12px";
          $container.style.padding = "16px";

          $container.appendChild(
            Typography.p("Menubar connected to HTML Editor:"),
          );

          let $editor: HtmlEditor = await HtmlEditor.make().bind({
            html: "<p>Select some text and use the toolbar buttons to format it.</p>",
            editable: true,
            minHeight: "150px",
            onChange: (html) => console.log("Editor content changed:", html),
          });

          const $menubar = TextInputMenubar.makeWith({
            groups: [["bold", "italic", "underline"]],
            onBold: () => {
              $editor.commands.toggleBold();
              Tracing.dev("Toggle Bold in editor");
            },
            onItalic: () => {
              $editor.commands.toggleUnderline();
              Tracing.dev("Toggle Underline in editor");
            },
            onUnderline: () => {
              $editor.commands.toggleUnderline();
              Tracing.dev("Toggle Underline in editor");
            },
          });

          $container.appendChild($menubar);
          $container.appendChild($editor);

          return $container;
        },
      },
    ];
  }
}
