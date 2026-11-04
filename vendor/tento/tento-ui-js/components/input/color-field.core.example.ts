import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { ColorField } from "./color-field";
import { InputLayout } from "./input-layout";

export class CoreColorFieldStoryBook extends Storybook.Default {
  title(): string {
    return "Color Field";
  }

  tags(): string[] {
    return ["std-color-field"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Accent color — click, Enter or Space opens the system picker",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Accent #3468A0");

          const $field = CoreColorFieldStoryBook.$bare(
            ColorField.makeWith({
              value: "#3468a0",
              // The native picker reports every intermediate color while the
              // user drags, so this fires continuously, not once on commit.
              onChange: (color) => {
                $status.bindText(`Accent ${color.toUpperCase()}`);
              },
            }),
          );
          return { $content: $field, $status };
        },
      },
      {
        title: "In a labeled form row",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Calendar color #2E7D5B");

          // std-input-layout supplies the surface fill (`--container-bg`) the
          // bare field expects, so no styling is needed on the field itself.
          const $layout = InputLayout.make().bind({
            label: "Calendar color",
            caption: "Used for events and the legend swatch",
          });
          $layout.appendChild(
            ColorField.makeWith({
              value: "#2e7d5b",
              onChange: (color) => {
                $status.bindText(`Calendar color ${color.toUpperCase()}`);
              },
            }),
          );
          return {
            $content: CoreColorFieldStoryBook.$frame($layout),
            $status,
          };
        },
      },
      {
        title: "Validation — too light to read on white is flagged",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $layout = InputLayout.make().bind({
            label: "Label color",
            required: true,
          });
          const $field = ColorField.make();

          // The field only paints the red border; the message comes from the
          // surrounding layout. Both are driven from the same check.
          const validate = (color: string) => {
            const tooLight = CoreColorFieldStoryBook.luminance(color) > 0.7;
            $field.setInvalid(tooLight);
            $layout.setInvalid(tooLight, "Too light to read on a white page");
            $status.bindText(
              tooLight
                ? `${color.toUpperCase()} rejected`
                : `${color.toUpperCase()} accepted`,
            );
          };

          $field.bind({ value: "#f1e9c6", onChange: validate });
          validate($field.value);
          $layout.appendChild($field);

          // The error line is absolutely positioned under the field, so the
          // frame reserves its height instead of letting it hang outside.
          const $frame = CoreColorFieldStoryBook.$frame($layout);
          $frame.style.paddingBottom = "20px";
          return { $content: $frame, $status };
        },
      },
      {
        title: "Set from code — only #RRGGBB is accepted",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const $field = ColorField.makeWith({ value: "#c2410c" });
          const report = (attempt: string) => {
            $status.bindText([
              `Assigned ${attempt}`,
              `Field holds ${$field.value.toUpperCase()}`,
            ]);
          };
          report("#c2410c");

          // Assigning `value` re-renders without calling onChange. Shorthand
          // hex and color names fail the #RRGGBB check and are dropped
          // silently, leaving the previous color in place.
          const $controls = Storybook.Card.Controls.make();
          for (const attempt of ["#7c3aed", "#abc", "teal"]) {
            $controls.appendChild(
              Button.makeWith(attempt, {
                type: "flat",
                onClick: () => {
                  $field.value = attempt;
                  report(attempt);
                },
              }),
            );
          }
          return {
            $content: CoreColorFieldStoryBook.$bare($field),
            $status,
            $controls,
          };
        },
      },
      {
        title: "No value — falls back to black",
        render: () =>
          CoreColorFieldStoryBook.$bare(ColorField.makeWith({ value: null })),
      },
    ];
  }

  /** `--container-bg` stands in for the form row that would normally
   * provide the bare field's fill. */
  private static $bare($field: ColorField): ColorField {
    $field.style.setProperty("--container-bg", "var(--bg-surface-light)");
    return $field;
  }

  private static $frame($child: HTMLElement): HTMLElement {
    const $frame = Column.make();
    $frame.assignStyles({ width: "min(320px, 100%)" });
    $frame.appendChild($child);
    return $frame;
  }

  /** Relative luminance (WCAG) of a #RRGGBB string, 0 = black, 1 = white. */
  private static luminance(hex: string): number {
    const channel = (offset: number) => {
      const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  }
}
