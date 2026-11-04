import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { TextAlignment, TextAlignmentInput } from "./text-alignment-input";

export class TextAlignmentInputStoryBook extends Storybook.Default {
  tags(): string[] {
    return ["std-text-alignment-input"];
  }

	title(): string {
		return "Text Alignment Input";
	}

	examples(): Storybook.Example[] {
		return [
			{
				title: "Basic Usage",
				render: () => {
					const $container = Column.make();
					$container.style.gap = "16px";
					$container.style.padding = "16px";

					const $alignment = TextAlignmentInput.makeWith({
						alignment: "center",
						onAlignmentChange: (alignment) => {
							$status.textContent = `Selected: ${alignment}`;
						},
					});
					$container.appendChild($alignment);

					const $status = Typography.small("Selected: center");
					$container.appendChild($status);

					return $container;
				},
			},
		];
	}
}
