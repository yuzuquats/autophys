import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { PropertyList } from "../input/property-list";
import { Breadcrumb } from "./breadcrumb";

export class BreadcrumbStoryBook extends Storybook.Default {
  title(): string {
    return "Breadcrumb";
  }

  tags(): string[] {
    return ["std-breadcrumb"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Breadcrumb",
        render: () => {
          const $breadcrumb = Breadcrumb.makeWith();
          $breadcrumb.appendChild(Breadcrumb.Item("Home"));
          $breadcrumb.appendChild(Breadcrumb.Item("Settings"));
          $breadcrumb.appendChild(Breadcrumb.Item("Profile"));
          return $breadcrumb;
        },
      },
      {
        title: "Small",
        render: () => {
          const $breadcrumb = Breadcrumb.makeWith("small");
          $breadcrumb.appendChild(Breadcrumb.Item("Home"));
          $breadcrumb.appendChild(Breadcrumb.Item("Settings"));
          $breadcrumb.appendChild(Breadcrumb.Item("Profile"));
          return $breadcrumb;
        },
      },
      {
        title: "Interactive",
        render: () => {
          const $breadcrumb = Breadcrumb.makeWith();
          let itemCount = 0;
          const addItem = () => {
            itemCount++;
            $breadcrumb.appendChild(Breadcrumb.Item(`Item ${itemCount}`));
          };
          addItem();
          addItem();

          return {
            $content: $breadcrumb,
            $controls: PropertyList.makeWith({
              add: {
                label: "Add",
                $e: Button.makeWithLight("Add Item", {
                  type: "primary",
                  size: "thin",
                  onClick: addItem,
                }),
                order: 0,
              },
              remove: {
                label: "Remove",
                $e: Button.makeWithLight("Remove Item", {
                  type: "secondary",
                  size: "thin",
                  onClick: () => {
                    const lastChild = $breadcrumb.lastElementChild;
                    if (lastChild) {
                      lastChild.remove();
                      itemCount--;
                    }
                  },
                }),
                order: 1,
              },
            }),
          };
        },
      },
      {
        title: "With Ellipsis",
        render: () => {
          const $breadcrumb = Breadcrumb.makeWith();
          $breadcrumb.appendChild(Breadcrumb.Item("Home"));
          $breadcrumb.appendChild(Breadcrumb.Ellipsis());
          $breadcrumb.appendChild(Breadcrumb.Item("Current"));
          return $breadcrumb;
        },
      },
      {
        title: "Text",
        render: () => {
          const $breadcrumb = Breadcrumb.makeWith();
          $breadcrumb.appendChild(
            Typography.p("Home").assignStyles({
              padding: "0px 4px",
            }),
          );
          $breadcrumb.appendChild(
            Typography.p("Products").assignStyles({
              padding: "0px 4px",
            }),
          );
          $breadcrumb.appendChild(
            Typography.p("Category").assignStyles({
              padding: "0px 4px",
            }),
          );
          return $breadcrumb;
        },
      },
      {
        title: "Single Item",
        render: () => {
          const $breadcrumb = Breadcrumb.makeWith();
          $breadcrumb.appendChild(Typography.p("Home"));
          return $breadcrumb;
        },
      },
    ];
  }
}
