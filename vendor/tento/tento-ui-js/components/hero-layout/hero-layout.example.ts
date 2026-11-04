import { Center } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { CarouselIndicator } from "../carousel/carousel-indicator";
import { LonaIcons, PlusIcon } from "../../ui/icons";
import { HeroLayout } from "./hero-layout";

function createColoredItem(
  text: string,
  color: string,
  isDimmed: boolean = true,
): HTMLElement {
  const $t = Typography.h3(text).assignStyles({
    transform:
      "scale(calc(1 / var(--scale) * (var(--not-selected) * 0.6 + var(--selected) * 1))",
  });
  const $content = Center.makeWith($t).assignStyles({
    background: isDimmed ? `var(--${color}-dimmed)` : `var(--${color})`,
    width: "100%",
    height: "100%",
  });
  const $item = HeroLayout.Item.makeWith({ borderRadius: 12 });
  $item.appendChild($content);
  return $item;
}

function createItemsFromColors(
  colors: string[],
  isDimmed: boolean = true,
): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const [idx, color] of colors.entries()) {
    items.push(createColoredItem(`Item ${idx + 1}`, color, isDimmed));
  }
  return items;
}

function createAddButton(): HTMLElement {
  const $addButton = Center.makeWith(
    LonaIcons.make(PlusIcon, { sizePx: 32 }),
  ).assignStyles({
    background: "var(--bg-surface-light)",
    width: "100%",
    height: "100%",
  });

  const $staticItem = HeroLayout.Item.makeWith({
    borderRadius: 12,
    isStatic: true,
    aspectRatio: 1,
    onClick: () => console.log("Add button clicked"),
  });
  $staticItem.appendChild($addButton);
  return $staticItem;
}

export class HeroLayoutStoryBook extends Storybook.Default {
  title(): string {
    return "Hero Layout";
  }

  tags(): string[] {
    return ["std-hero-layout", "std-hero-layout-item"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Hero Layout",
        render: () => {
          let selectedIndex = 0;
          let showNavBar = true;
          const colors = [
            "blue",
            "red",
            "green",
            "yellow",
            "purple",
            "teal",
            "orange",
            "gray",
          ];

          const $items = createItemsFromColors(colors);
          $items.push(createAddButton());

          const updateLayout = (): void => {
            $heroLayout.bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 60, height: 60 },
              showNavBar: showNavBar,
              onChange: onChange,
            });
          };

          const $indicator = CarouselIndicator.makeWith({
            count: colors.length,
            isExpanded: true,
            onToggle: (isExpanded) => {
              showNavBar = isExpanded;
              updateLayout();
            },
            onEdit: () => console.log("Edit carousel"),
          });
          $indicator.slot = "controls";

          const onChange = (index: number): void => {
            selectedIndex = index;
            updateLayout();
          };

          const $heroLayout = HeroLayout.make();
          $heroLayout.append(...$items);
          $heroLayout.appendChild($indicator);

          return $heroLayout
            .bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 60, height: 60 },
              showNavBar: showNavBar,
              onChange: onChange,
            })
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              padding: "2px",
              border: "1px solid var(--divider)",
              borderRadius: "8px",
            });
        },
      },
      {
        title: "Hero Layout (custom height)",
        render: () => {
          let selectedIndex = 0;
          let showNavBar = true;
          const colors = [
            "blue",
            "red",
            "green",
            "yellow",
            "purple",
            "teal",
            "orange",
            "gray",
            "blue",
            "red",
          ];

          const $items = createItemsFromColors(colors);

          const updateLayout = (): void => {
            $heroLayout.bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 60, height: 60 },
              showNavBar: showNavBar,
              onChange: onChange,
            });
          };

          const $indicator = CarouselIndicator.makeWith({
            count: colors.length,
            isExpanded: showNavBar,
            onToggle: (isExpanded) => {
              showNavBar = isExpanded;
              updateLayout();
            },
            onEdit: () => console.log("Edit carousel"),
          });
          $indicator.slot = "controls";

          const onChange = (index: number): void => {
            selectedIndex = index;
            updateLayout();
          };

          const $heroLayout = HeroLayout.make();
          $heroLayout.append(...$items);
          $heroLayout.appendChild($indicator);

          return $heroLayout
            .bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 60, height: 60 },
              showNavBar: showNavBar,
              onChange: onChange,
            })
            .assignStyles({
              height: "800px",
              width: "100%",
              maxWidth: "400px",
              padding: "2px",
              border: "1px solid var(--divider)",
              borderRadius: "8px",
            });
        },
      },
      {
        title: "Hero Layout (custom height - small)",
        render: () => {
          let selectedIndex = 0;
          let showNavBar = true;
          const colors = [
            "blue",
            "red",
            "green",
            "yellow",
            "purple",
            "teal",
            "orange",
            "gray",
            "blue",
            "red",
          ];

          const $items = createItemsFromColors(colors);

          const updateLayout = (): void => {
            $heroLayout.bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 60, height: 60 },
              showNavBar: showNavBar,
              onChange: onChange,
            });
          };

          const $indicator = CarouselIndicator.makeWith({
            count: colors.length,
            isExpanded: showNavBar,
            onToggle: (isExpanded) => {
              showNavBar = isExpanded;
              updateLayout();
            },
            onEdit: () => console.log("Edit carousel"),
          });
          $indicator.slot = "controls";

          const onChange = (index: number): void => {
            selectedIndex = index;
            updateLayout();
          };

          const $heroLayout = HeroLayout.make();
          $heroLayout.append(...$items);
          $heroLayout.appendChild($indicator);

          return $heroLayout
            .bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 60, height: 60 },
              showNavBar: showNavBar,
              onChange: onChange,
            })
            .assignStyles({
              height: "300px",
              width: "100%",
              maxWidth: "400px",
              padding: "2px",
              border: "1px solid var(--divider)",
              borderRadius: "8px",
            });
        },
      },
      {
        title: "Hero Layout (no scrollbar)",
        render: () => {
          let selectedIndex = 0;
          let showNavBar = true;
          const colors = ["blue", "red", "green", "yellow", "purple"];

          const $items = createItemsFromColors(colors);

          const updateLayout = (): void => {
            $heroLayout.bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 60, height: 60 },
              showNavBar: showNavBar,
              showScrollbar: false,
              onChange: onChange,
            });
          };

          const $indicator = CarouselIndicator.makeWith({
            count: colors.length,
            isExpanded: showNavBar,
            onToggle: (isExpanded) => {
              showNavBar = isExpanded;
              updateLayout();
            },
            onEdit: () => console.log("Edit carousel"),
          });
          $indicator.slot = "controls";

          const onChange = (index: number): void => {
            selectedIndex = index;
            updateLayout();
          };

          const $heroLayout = HeroLayout.make();
          $heroLayout.append(...$items);
          $heroLayout.appendChild($indicator);

          return $heroLayout
            .bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 60, height: 60 },
              showNavBar: showNavBar,
              showScrollbar: false,
              onChange: onChange,
            })
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              padding: "2px",
              border: "1px solid var(--divider)",
              borderRadius: "8px",
            });
        },
      },
      {
        title: "Large Previews",
        render: () => {
          let selectedIndex = 0;
          let showNavBar = true;

          const colors = ["teal", "orange", "purple", "blue"];
          const items = createItemsFromColors(colors, false);

          const updateLayout = (): void => {
            $heroLayout.bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 100, height: 100 },
              showNavBar: showNavBar,
              onChange: onChange,
            });
          };

          const $indicator = CarouselIndicator.makeWith({
            count: colors.length,
            isExpanded: showNavBar,
            onToggle: (isExpanded) => {
              showNavBar = isExpanded;
              updateLayout();
            },
            onEdit: () => console.log("Edit carousel"),
          });
          $indicator.slot = "controls";

          const onChange = (index: number): void => {
            selectedIndex = index;
            updateLayout();
          };

          const $heroLayout = HeroLayout.make();
          $heroLayout.append(...items);
          $heroLayout.appendChild($indicator);

          return $heroLayout
            .bind({
              selectedIndex: selectedIndex,
              previewSize: { width: 100, height: 100 },
              showNavBar: showNavBar,
              onChange: onChange,
            })
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              border: "1px solid var(--divider)",
              borderRadius: "8px",
            });
        },
      },
      {
        title: "Calculate Square Preview Size",
        render: () => {
          const previewSize = HeroLayout.calculateSquarePreviewSize(
            400,
            480,
            5,
            2,
            2,
          );

          let selectedIndex = 0;
          let showNavBar = true;

          const colors = ["blue", "red", "green", "yellow", "purple"];
          const $heroLayout = HeroLayout.make();
          $heroLayout.append(...createItemsFromColors(colors));

          const updateLayout = (): void => {
            $heroLayout.bind({
              selectedIndex,
              previewSize,
              rowGap: 2,
              showNavBar,
              onChange: (index: number) => {
                selectedIndex = index;
                updateLayout();
              },
            });
          };

          const $indicator = CarouselIndicator.makeWith({
            count: colors.length,
            isExpanded: showNavBar,
            onToggle: (isExpanded) => {
              showNavBar = isExpanded;
              updateLayout();
            },
            onEdit: () => console.log("Edit carousel"),
          });
          $indicator.slot = "controls";
          $heroLayout.appendChild($indicator);

          return $heroLayout
            .bind({
              selectedIndex,
              previewSize,
              rowGap: 2,
              showNavBar,
              onChange: (index: number) => {
                selectedIndex = index;
                updateLayout();
              },
            })
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              height: "480px",
              border: "1px solid var(--divider)",
              borderRadius: "8px",
            });
        },
      },
      {
        title: "Calculate Preview Width From Height",
        render: () => {
          const previewWidth = HeroLayout.calculatePreviewWidthFromHeight(
            400,
            480,
            64,
            2,
          );

          let selectedIndex = 0;
          let showNavBar = true;

          const colors = ["teal", "orange", "purple", "blue", "red"];
          const $heroLayout = HeroLayout.make();
          $heroLayout.append(...createItemsFromColors(colors));

          const updateLayout = (): void => {
            $heroLayout.bind({
              selectedIndex,
              previewSize: { width: previewWidth, height: 64 },
              rowGap: 2,
              showNavBar,
              onChange: (index: number) => {
                selectedIndex = index;
                updateLayout();
              },
            });
          };

          const $indicator = CarouselIndicator.makeWith({
            count: colors.length,
            isExpanded: showNavBar,
            onToggle: (isExpanded) => {
              showNavBar = isExpanded;
              updateLayout();
            },
            onEdit: () => console.log("Edit carousel"),
          });
          $indicator.slot = "controls";
          $heroLayout.appendChild($indicator);

          return $heroLayout
            .bind({
              selectedIndex,
              previewSize: { width: previewWidth, height: 64 },
              rowGap: 2,
              showNavBar,
              onChange: (index: number) => {
                selectedIndex = index;
                updateLayout();
              },
            })
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              height: "480px",
              border: "1px solid var(--divider)",
              borderRadius: "8px",
            });
        },
      },
    ];
  }
}
