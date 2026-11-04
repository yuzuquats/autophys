import { html, LonaWebComponent } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Storybook } from "./storybook";

@component({ name: "dev-typography-example" })
class TypographyExampleComponent extends LonaWebComponent {
  static $styles = [
    css`
      .type-container {
        display: inline-block;
        width: 100%;
        margin-top: 40px;
        background-color: var(--bg);
      }
      .spacer {
        height: 40px;
        width: 100%;
        background: var(--red);
        border-radius: 4px;
        opacity: 0.5;
      }
    `,
  ];

  static $html = html`
    <div style="" id="component">
      <div class="spacer"></div>
      <std-flex>
        <h1>Heading level 1</h1>
      </std-flex>
      <div class="spacer"></div>
      <std-flex>
        <h2>Heading level 2</h2>
      </std-flex>
      <div class="spacer"></div>
      <std-flex>
        <h3>Heading level 3</h3>
      </std-flex>
      <div class="spacer"></div>
      <std-flex>
        <h4>Heading level 4</h4>
      </std-flex>
      <div class="spacer"></div>
      <std-flex>
        <h5>Heading level 5</h5>
      </std-flex>
      <div class="spacer"></div>
      <std-flex>
        <h6>Heading level 6</h6>
      </std-flex>
      <div class="spacer"></div>
      <std-flex>
        <p>Paragraph</p>
      </std-flex>
      <div class="spacer"></div>
      <std-flex>
        <p class="small">Small</p>
      </std-flex>
      <div class="spacer"></div>
      <std-flex>
        <p>
          Quos atque officia quod. <i>Suscipit delectus</i> cupidatat, quia nulla
          numquam aute cillum proident. Maiores iusto culpa molestias quam id
          tenetur saepe impedit reiciendis itaque ducimus itaque nostrud. Tempor
          aliquip, culpa earum itaque sed consequatur minus aliquip reprehenderit
          nihil veniam tempora do maxime omnis reiciendis elit&nbsp;tempora.
        </p>
      </std-flex>
      <div class="spacer"></div>
    </div>
  `;
}

export class TypographyStoryBook extends Storybook.Default {
  title(): string {
    return "Typography";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          return TypographyExampleComponent.make();
        },
      },
    ];
  }
}
