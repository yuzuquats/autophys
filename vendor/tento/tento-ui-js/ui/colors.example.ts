import { html, LonaWebComponent } from "../component";
import { Column, Row } from "../component-builtin";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Round } from "../components/round";
import { CalendarIcon, CheckmarkIcon, GearIcon, LonaIcons } from "./icons";
import { Storybook } from "./storybook";
import { Typography } from "./typography";

@component({ name: "dev-color-swatch" })
class ColorSwatch extends LonaWebComponent {
  private $swatch: Round = this.hydrate("swatch");
  private $varName: HTMLElement = this.$("varName");

  bind(props: ColorSwatch.Props): this {
    this.$swatch.bind({
      radius: 24,
      bg: `var(${props.varName})`,
    });
    this.$varName.textContent = props.varName;
    return this;
  }

  static $html = html`
    <div class="swatch-container">
      <std-round id="swatch" class="swatch"></std-round>
      <div id="varName" class="var-name"></div>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: inline-block;
      }

      .swatch-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
      }

      .swatch {
        width: 48px;
        height: 48px;
      }

      .var-name {
        font-size: var(--text-12px);
        color: var(--text-sec);
        font-family: monospace;
      }
    `,
  ];
}

export namespace ColorSwatch {
  export type Props = {
    varName: string;
  };
}

@component({ name: "dev-surface-demo" })
class SurfaceDemo extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private $label: HTMLElement = this.$("label");
  private $content: HTMLElement = this.$("content");

  bind(props: SurfaceDemo.Props): this {
    this.$container.style.backgroundColor = `var(${props.bgVar})`;
    this.$label.textContent = props.label;

    this.$content.innerHTML = "";
    for (const child of props.children) {
      this.$content.appendChild(child);
    }

    return this;
  }

  static $html = html`
    <div class="surface-container">
      <div id="label" class="surface-label"></div>
      <div id="container" class="surface">
        <div id="content"></div>
      </div>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: block;
      }

      .surface-container {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .surface-label {
        font-size: var(--text-12px);
        color: var(--text-sec);
        font-family: monospace;
      }

      .surface {
        padding: 16px;
        border-radius: 8px;
        border: 1px solid var(--divider);
      }

      #content {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
    `,
  ];
}

export namespace SurfaceDemo {
  export type Props = {
    label: string;
    bgVar: string;
    children: HTMLElement[];
  };
}

export class SystemColorsStoryBook extends Storybook.Default {
  title(): string {
    return "System Colors";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const colors = [
            { varName: "--red" },
            { varName: "--red-dimmed" },
            { varName: "--orange" },
            { varName: "--orange-dimmed" },
            { varName: "--yellow" },
            { varName: "--yellow-dimmed" },
            { varName: "--green" },
            { varName: "--green-dimmed" },
            { varName: "--blue" },
            { varName: "--blue-dimmed" },
            { varName: "--purple" },
            { varName: "--purple-dimmed" },
            { varName: "--gray" },
            { varName: "--gray-dimmed" },
            { varName: "--teal" },
            { varName: "--teal-dimmed" },
          ];

          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
            gap: "16px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          for (const color of colors) {
            const $swatch = ColorSwatch.make().bind(color);
            $grid.appendChild($swatch);
          }

          return {
            $content: $grid,
          };
        },
      },
    ];
  }
}

export class TextColorsStoryBook extends Storybook.Default {
  title(): string {
    return "Text Colors";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
            gap: "12px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          const $bgDemo = SurfaceDemo.make().bind({
            label: "--bg",
            bgVar: "--bg",
            children: [
              Typography.h2("Primary Text").assignStyles({
                color: "var(--text-pri)",
              }),
              Typography.p("Secondary Text").assignStyles({
                color: "var(--text-sec)",
              }),
              Typography.small("Tertiary Text").assignStyles({
                color: "var(--text-ter)",
              }),
            ],
          });

          const $elevatedDemo = SurfaceDemo.make().bind({
            label: "--bg-elevated",
            bgVar: "--bg-elevated",
            children: [
              Typography.h2("Primary Text").assignStyles({
                color: "var(--text-pri)",
              }),
              Typography.p("Secondary Text").assignStyles({
                color: "var(--text-sec)",
              }),
              Typography.small("Tertiary Text").assignStyles({
                color: "var(--text-ter)",
              }),
            ],
          });

          const $surfaceDemo = SurfaceDemo.make().bind({
            label: "--bg-surface",
            bgVar: "--bg-surface",
            children: [
              Typography.h2("Primary Text").assignStyles({
                color: "var(--text-pri)",
              }),
              Typography.p("Secondary Text").assignStyles({
                color: "var(--text-sec)",
              }),
              Typography.small("Tertiary Text").assignStyles({
                color: "var(--text-ter)",
              }),
            ],
          });

          const $inverseDemo = SurfaceDemo.make().bind({
            label: "Dark surface with inverse text",
            bgVar: "--black50",
            children: [
              Typography.h2("Inverse Primary").assignStyles({
                color: "var(--text-pri-inv)",
              }),
              Typography.p("Inverse Secondary").assignStyles({
                color: "var(--text-sec-inv)",
              }),
              Typography.small("Inverse Tertiary").assignStyles({
                color: "var(--text-ter-inv)",
              }),
            ],
          });

          $grid.append($bgDemo, $elevatedDemo, $surfaceDemo, $inverseDemo);

          return {
            $content: $grid,
          };
        },
      },
    ];
  }
}

export class BackgroundsStoryBook extends Storybook.Default {
  title(): string {
    return "Backgrounds";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
            gap: "12px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          const surfaces = [
            {
              label: "--bg",
              varName: "--bg",
              description: "Default background",
            },
            {
              label: "--bg-surface",
              varName: "--bg-surface",
              description: "Standard surface",
            },
            {
              label: "--bg-surface-light",
              varName: "--bg-surface-light",
              description: "Light surface variant",
            },
            {
              label: "--bg-elevated",
              varName: "--bg-elevated",
              description: "Elevated surface (cards, modals)",
            },
            {
              label: "--bg-overlay",
              varName: "--bg-overlay",
              description: "Overlay background",
            },
          ];

          for (const surface of surfaces) {
            const $demo = SurfaceDemo.make().bind({
              label: surface.label,
              bgVar: surface.varName,
              children: [
                Typography.p(surface.description).assignStyles({
                  color: "var(--text-pri)",
                }),
              ],
            });
            $grid.appendChild($demo);
          }

          return {
            $content: $grid,
          };
        },
      },
    ];
  }
}

export class IconColorsStoryBook extends Storybook.Default {
  title(): string {
    return "Icon Colors";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const createIconRow = (colorVar: string): HTMLElement => {
            const $row = Row.make();
            $row.assignStyles({
              gap: "8px",
              alignItems: "center",
            });

            const icons = [CalendarIcon, CheckmarkIcon, GearIcon];

            for (const icon of icons) {
              const $icon = LonaIcons.make(icon, { sizePx: 20 });
              $icon.style.color = `var(${colorVar})`;
              $row.appendChild($icon);
            }

            return $row;
          };

          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
            gap: "12px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          const $bgRow1 = Row.make();
          $bgRow1.append(
            Typography.small("Primary:").assignStyles({
              color: "var(--text-sec)",
              width: "100px",
            }),
            createIconRow("--fg-icon-pri"),
          );

          const $bgRow2 = Row.make();
          $bgRow2.append(
            Typography.small("Secondary:").assignStyles({
              color: "var(--text-sec)",
              width: "100px",
            }),
            createIconRow("--fg-icon-sec"),
          );

          const $bgRow3 = Row.make();
          $bgRow3.append(
            Typography.small("Tertiary:").assignStyles({
              color: "var(--text-sec)",
              width: "100px",
            }),
            createIconRow("--fg-icon-ter"),
          );

          const $bgDemo = SurfaceDemo.make().bind({
            label: "--bg",
            bgVar: "--bg",
            children: [$bgRow1, $bgRow2, $bgRow3],
          });

          const $elevatedRow1 = Row.make();
          $elevatedRow1.append(
            Typography.small("Primary:").assignStyles({
              color: "var(--text-sec)",
              width: "100px",
            }),
            createIconRow("--fg-icon-pri"),
          );

          const $elevatedRow2 = Row.make();
          $elevatedRow2.append(
            Typography.small("Secondary:").assignStyles({
              color: "var(--text-sec)",
              width: "100px",
            }),
            createIconRow("--fg-icon-sec"),
          );

          const $elevatedRow3 = Row.make();
          $elevatedRow3.append(
            Typography.small("Tertiary:").assignStyles({
              color: "var(--text-sec)",
              width: "100px",
            }),
            createIconRow("--fg-icon-ter"),
          );

          const $elevatedDemo = SurfaceDemo.make().bind({
            label: "--bg-elevated",
            bgVar: "--bg-elevated",
            children: [$elevatedRow1, $elevatedRow2, $elevatedRow3],
          });

          $grid.append($bgDemo, $elevatedDemo);

          return {
            $content: $grid,
          };
        },
      },
    ];
  }
}

export class DividersStoryBook extends Storybook.Default {
  title(): string {
    return "Dividers";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const createDivider = (colorVar: string): HTMLElement => {
            const $divider = document.createElement("div");
            $divider.style.height = "1px";
            $divider.style.backgroundColor = `var(${colorVar})`;
            $divider.style.margin = "8px 0";
            return $divider;
          };

          const createVerticalDivider = (colorVar: string): HTMLElement => {
            const $divider = document.createElement("div");
            $divider.style.width = "1px";
            $divider.style.height = "24px";
            $divider.style.backgroundColor = `var(${colorVar})`;
            $divider.style.margin = "0 16px";
            return $divider;
          };

          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
            gap: "12px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          const $standardDemo = SurfaceDemo.make().bind({
            label: "--divider",
            bgVar: "--bg",
            children: [
              Typography.p("Content above"),
              createDivider("--divider"),
              Typography.p("Content below"),
            ],
          });

          const $primaryDemo = SurfaceDemo.make().bind({
            label: "--divider-pri",
            bgVar: "--bg",
            children: [
              Typography.p("Content above"),
              createDivider("--divider-pri"),
              Typography.p("Content below"),
            ],
          });

          const $verticalRow = Row.make();
          $verticalRow.append(
            Typography.p("Left"),
            createVerticalDivider("--divider"),
            Typography.p("Middle"),
            createVerticalDivider("--divider"),
            Typography.p("Right"),
          );
          $verticalRow.assignStyles({
            alignItems: "center",
          });

          const $verticalDemo = SurfaceDemo.make().bind({
            label: "Vertical dividers",
            bgVar: "--bg",
            children: [$verticalRow],
          });

          $grid.append($standardDemo, $primaryDemo, $verticalDemo);

          return {
            $content: $grid,
          };
        },
      },
    ];
  }
}

export class InteractiveStatesStoryBook extends Storybook.Default {
  title(): string {
    return "Interactive States";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const createHoverableBox = (
            hoverVar: string,
            text: string,
          ): HTMLElement => {
            const $box = document.createElement("div");
            $box.style.padding = "16px";
            $box.style.borderRadius = "8px";
            $box.style.border = "1px solid var(--divider)";
            $box.style.cursor = "pointer";
            $box.style.transition = "background-color 0.3s ease";
            $box.textContent = text;

            $box.addEventListener("mouseenter", () => {
              $box.style.backgroundColor = `var(${hoverVar})`;
            });

            $box.addEventListener("mouseleave", () => {
              $box.style.backgroundColor = "transparent";
            });

            return $box;
          };

          const createBox = (bgVar: string, text: string): HTMLElement => {
            const $box = document.createElement("div");
            $box.style.padding = "16px";
            $box.style.borderRadius = "8px";
            $box.style.backgroundColor = `var(${bgVar})`;
            $box.textContent = text;
            return $box;
          };

          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
            gap: "12px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          const $hoverDemo = SurfaceDemo.make().bind({
            label: "Hover State",
            bgVar: "--bg",
            children: [createHoverableBox("--bg-hover", "Hover over this box")],
          });

          const $hoverLightDemo = SurfaceDemo.make().bind({
            label: "Hover Light State",
            bgVar: "--bg",
            children: [
              createHoverableBox("--bg-hover-light", "Hover over this box"),
            ],
          });

          const $selectedBox = SurfaceDemo.make().bind({
            label: "--bg-selected",
            bgVar: "--bg",
            children: [createBox("--bg-selected", "Selected item")],
          });

          $grid.append($hoverDemo, $hoverLightDemo, $selectedBox);

          return {
            $content: $grid,
          };
        },
      },
    ];
  }
}

export class OpacityVariantsStoryBook extends Storybook.Default {
  title(): string {
    return "Opacity Variants";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const createOpacityGrid = (
            opacities: Array<{ varName: string }>,
            bgVar: string,
          ): HTMLElement => {
            const $grid = document.createElement("div");
            $grid.assignStyles({
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))",
              gap: "12px",
              padding: "16px",
              width: "100%",
              maxWidth: "1200px",
              backgroundColor: `var(${bgVar})`,
              borderRadius: "8px",
            });

            for (const opacity of opacities) {
              const $item = Column.make();
              $item.assignStyles({
                alignItems: "center",
                gap: "6px",
              });

              const $swatch = Round.make();
              $swatch.bind({ bg: `var(${opacity.varName})` });
              $swatch.assignStyles({
                width: "48px",
                height: "48px",
              });

              const $varName = Typography.small(opacity.varName);
              $varName.assignStyles({
                color:
                  bgVar === "--bg"
                    ? "var(--text-sec)"
                    : "var(--text-sec-inv)",
                fontFamily: "monospace",
              });

              $item.append($swatch, $varName);
              $grid.appendChild($item);
            }

            return $grid;
          };

          const $container = Column.make();
          $container.assignStyles({
            gap: "24px",
            padding: "12px",
            width: "100%",
          });

          const $blackTitle = Typography.h3("Black Opacity");

          const blackOpacities = [
            { varName: "--black3" },
            { varName: "--black6" },
            { varName: "--black9" },
            { varName: "--black12" },
            { varName: "--black16" },
            { varName: "--black20" },
            { varName: "--black33" },
            { varName: "--black50" },
          ];

          const $blackGrid = createOpacityGrid(blackOpacities, "--bg");

          const $whiteTitle = Typography.h3("White Opacity");

          const whiteOpacities = [
            { varName: "--white3" },
            { varName: "--white6" },
            { varName: "--white9" },
            { varName: "--white12" },
            { varName: "--white20" },
            { varName: "--white33" },
            { varName: "--white50" },
          ];

          const $whiteGrid = createOpacityGrid(whiteOpacities, "--black50");

          $container.append($blackTitle, $blackGrid, $whiteTitle, $whiteGrid);

          return {
            $content: $container,
          };
        },
      },
    ];
  }
}

export class SemanticColorsStoryBook extends Storybook.Default {
  title(): string {
    return "Semantic Colors (Phase 2.1)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Success",
        render: () => {
          const colors = [
            { varName: "--color-success" },
            { varName: "--color-success-dimmed" },
            { varName: "--color-success-container" },
            { varName: "--color-on-success" },
            { varName: "--color-on-success-container" },
          ];

          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: "16px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          for (const color of colors) {
            const $swatch = ColorSwatch.make().bind(color);
            $grid.appendChild($swatch);
          }

          return {
            $content: $grid,
          };
        },
      },
      {
        title: "Error",
        render: () => {
          const colors = [
            { varName: "--color-error" },
            { varName: "--color-error-dimmed" },
            { varName: "--color-error-container" },
            { varName: "--color-on-error" },
            { varName: "--color-on-error-container" },
          ];

          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: "16px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          for (const color of colors) {
            const $swatch = ColorSwatch.make().bind(color);
            $grid.appendChild($swatch);
          }

          return {
            $content: $grid,
          };
        },
      },
      {
        title: "Warning",
        render: () => {
          const colors = [
            { varName: "--color-warning" },
            { varName: "--color-warning-dimmed" },
            { varName: "--color-warning-container" },
            { varName: "--color-on-warning" },
            { varName: "--color-on-warning-container" },
          ];

          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: "16px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          for (const color of colors) {
            const $swatch = ColorSwatch.make().bind(color);
            $grid.appendChild($swatch);
          }

          return {
            $content: $grid,
          };
        },
      },
      {
        title: "Info",
        render: () => {
          const colors = [
            { varName: "--color-info" },
            { varName: "--color-info-dimmed" },
            { varName: "--color-info-container" },
            { varName: "--color-on-info" },
            { varName: "--color-on-info-container" },
          ];

          const $grid = document.createElement("div");
          $grid.assignStyles({
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: "16px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          for (const color of colors) {
            const $swatch = ColorSwatch.make().bind(color);
            $grid.appendChild($swatch);
          }

          return {
            $content: $grid,
          };
        },
      },
    ];
  }
}
