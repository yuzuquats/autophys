import { html, LonaWebComponent } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { Storybook } from "../ui/storybook";
import { Shimmer } from "./shimmer";

@component({
  name: "dev-shimmer-example",
})
class ShimmerExample extends LonaWebComponent {
  static $styles: Style.Compat[] = [
    Shimmer.$style,
    css`
			#root {
				align-items: flex-start;
				gap: 4px;
				border-radius: 8px;
				padding: 12px;
				width: 180px;
				background: var(--bg);
			}

			.shimmer-overlay {
				border-radius: 4px;
				padding: 2px;
			}
		`,
  ];
  static $html = html`
		<std-col id=root>
			<std-block class=shimmer-overlay><p>Hello World</p></std-block>
			<std-block class=shimmer-overlay><p>Test longer text</p></std-block>
		</std-col>
	`;
}

export class ShimmerStoryBook extends Storybook.Default {
  title(): string {
    return "Shimmer";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          return ShimmerExample.make();
        },
      },
    ];
  }
}
