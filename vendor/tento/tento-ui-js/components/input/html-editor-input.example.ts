import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { HtmlEditorInput } from "./html-editor-input";

export class HtmlEditorInputStoryBook extends Storybook.Default {
  tags(): string[] {
    return ["std-html-editor-input"];
  }

	title(): string {
		return "HTML Editor Input";
	}

	examples(): Storybook.Example[] {
		return [
			{
				title: "With Initial Content",
				render: () => {
					const $input = HtmlEditorInput.makeWith({
						html: "<h3>Welcome</h3><p>This is some <strong>initial</strong> HTML content.</p><ul><li>Item 1</li><li>Item 2</li></ul>",
						modalTitle: "Edit Content",
						onChange: (html) => {
							console.log("HTML changed:", html);
						},
					}).assignStyles({
						height: "200px",
						width: "280px",
						borderRadius: "8px",
						background: "var(--bg-surface-light)",
					});
					return $input;
				},
			},
		];
	}
}
