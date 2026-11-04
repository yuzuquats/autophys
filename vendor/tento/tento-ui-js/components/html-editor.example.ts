import { Storybook } from "@tento-ui/ui/storybook";
import { Typography } from "@tento-ui/ui/typography";
import { Column } from "../component-builtin";
import { Button } from "./button/button";
import { HtmlEditor } from "./html-editor";

export class HtmlEditorStoryBook extends Storybook.Default {
  tags(): string[] {
    return ["std-html-editor"];
  }

	title(): string {
		return "HTML Editor";
	}

	preview(): Storybook.Example {
		return {
			title: "HTML Editor Preview",
			render: async () => {
				const $container = Column.make();

				const editor = HtmlEditor.make();
				await editor.bind({
					html: "<p>Rich text editor with <strong>HTML</strong> support</p>",
					placeholder: "Start typing...",
					editable: true,
					minHeight: "150px",
					maxHeight: "300px",
				});

				$container.appendChild(editor);

				return $container;
			},
		};
	}

	examples(): Storybook.Example[] {
		return [
			{
				title: "With Initial Content",
				render: async () => {
					const initialHtml = `
            <h1>Welcome to the HTML Editor</h1>
            <p>This editor supports <strong>bold</strong>, <em>italic</em>, <u>underline</u>, and <s>strikethrough</s> text.</p>
            <h2>Features</h2>
            <ul>
              <li>Rich text formatting</li>
              <li>Lists (ordered and unordered)</li>
              <li>Headings (H1-H6)</li>
              <li><a href="https://example.com">Links</a></li>
            </ul>
            <p>You can also add <code>inline code</code> and horizontal rules:</p>
            <hr>
            <p>The editor automatically sanitizes HTML to prevent XSS attacks.</p>
          `;

					const $editor = HtmlEditor.make();
					await $editor.bind({
						html: initialHtml,
						editable: true,
						minHeight: "300px",
						maxHeight: "500px",
					});
					$editor.assignStyles({
						height: "200px",
						width: "280px",
						borderRadius: "8px",
						background: "var(--bg-surface-light)",
					});
					return $editor;
				},
			},
			{
				title: "With Change Handler",
				render: async () => {
					const $container = Column.make();
					$container.style.gap = "8px";

					const $output = document.createElement("std-col");
					$output.style.padding = "12px";
					$output.style.background = "var(--bg-surface-light)";
					$output.style.borderRadius = "4px";
					$output.style.minHeight = "100px";

					const $charCount = Typography.small("Characters: 0");

					const $preview = Typography.p("");
					$output.appendChild($preview);

					const $editor = HtmlEditor.make();
					await $editor.bind({
						html: null,
						editable: true,
						minHeight: "150px",
						placeholder: "Edit this content to see changes...",
						onChange: (html) => {
							$charCount.textContent = `Characters: ${html.length}`;
							$preview.textContent = html;
						},
					});
					$editor.assignStyles({
						height: "200px",
						width: "280px",
						borderRadius: "8px",
						background: "var(--bg-surface-light)",
					});

					$container.appendChild($editor);
					$container.appendChild(Typography.p("HTML Output:"));
					$container.appendChild($output);
					$container.appendChild($charCount);

					return $container;
				},
			},
		];
	}
}

// Register the storybook
export default HtmlEditorStoryBook;
