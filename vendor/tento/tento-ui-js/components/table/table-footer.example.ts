import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { PropertyList } from "../input/property-list";
import { TableFooter } from "./table-footer";
import { Toast } from "../toast/toast";

export class TableFooterStoryBook extends Storybook.Default {
  title(): string {
    return "Table Footer";
  }

  tags(): string[] {
    return ["std-table-footer"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic Pagination",
        render: () => {
          const $footer = TableFooter.make();
          $footer.bind({
            currentPage: 1,
            pageSize: 25,
            totalItems: 100,
            onPageChange: (page) => {
              Toast.makeWith({ title: `Page changed to ${page}` }).show();
            },
            onPageSizeChange: (pageSize) => {
              Toast.makeWith({ title: `Page size changed to ${pageSize}` }).show();
            },
          });

          return $footer.assignStyles({
            width: "100%",
            maxWidth: "800px",
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
      {
        title: "Many Pages (with ellipsis)",
        render: () => {
          const $footer = TableFooter.make();
          $footer.bind({
            currentPage: 5,
            pageSize: 10,
            totalItems: 500,
            onPageChange: (page) => {
              Toast.makeWith({ title: `Page changed to ${page}` }).show();
            },
            onPageSizeChange: (pageSize) => {
              Toast.makeWith({ title: `Page size changed to ${pageSize}` }).show();
            },
          });

          return $footer.assignStyles({
            width: "100%",
            maxWidth: "800px",
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
      {
        title: "Few Items (single page)",
        render: () => {
          const $footer = TableFooter.make();
          $footer.bind({
            currentPage: 1,
            pageSize: 25,
            totalItems: 15,
            onPageChange: (page) => {
              Toast.makeWith({ title: `Page changed to ${page}` }).show();
            },
            onPageSizeChange: (pageSize) => {
              Toast.makeWith({ title: `Page size changed to ${pageSize}` }).show();
            },
          });

          return $footer.assignStyles({
            width: "100%",
            maxWidth: "800px",
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
      {
        title: "Empty State",
        render: () => {
          const $footer = TableFooter.make();
          $footer.bind({
            currentPage: 1,
            pageSize: 25,
            totalItems: 0,
            onPageChange: (page) => {
              Toast.makeWith({ title: `Page changed to ${page}` }).show();
            },
            onPageSizeChange: (pageSize) => {
              Toast.makeWith({ title: `Page size changed to ${pageSize}` }).show();
            },
          });

          return $footer.assignStyles({
            width: "100%",
            maxWidth: "800px",
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
      {
        title: "Interactive Demo",
        render: () => {
          let currentPage = 1;
          let pageSize = 25;
          const totalItems = 237;

          const $footer = TableFooter.make();
          const updateFooter = () => {
            $footer.bind({
              currentPage,
              pageSize,
              totalItems,
              onPageChange: (page) => {
                currentPage = page;
                updateFooter();
              },
              onPageSizeChange: (newPageSize) => {
                pageSize = newPageSize;
                currentPage = 1;
                updateFooter();
              },
            });
          };

          updateFooter();

          const $container = document.createElement("std-col");
          $container.assignStyles({
            width: "100%",
            maxWidth: "800px",
            gap: "16px",
          });

          const $description = Typography.p(
            "Try navigating between pages and changing the page size. The footer updates automatically.",
          );
          $description.assignStyles({ color: "var(--text-sec)" });

          $footer.assignStyles({
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });

          $container.append($description, $footer);
          return $container;
        },
      },
      {
        title: "Different Page Sizes",
        render: () => {
          const $col = document.createElement("std-col");
          $col.assignStyles({
            gap: "24px",
            width: "100%",
            maxWidth: "800px",
          });

          const sizes = [10, 25, 50, 100];

          for (const size of sizes) {
            const $section = document.createElement("std-col");
            $section.assignStyles({ gap: "8px" });

            const $label = Typography.h6(`Page size: ${size}`);

            const $footer = TableFooter.make();
            $footer.bind({
              currentPage: 1,
              pageSize: size,
              totalItems: 250,
              onPageChange: (page) => {
                Toast.makeWith({ title: `Page ${page} (size ${size})` }).show();
              },
              onPageSizeChange: (newSize) => {
                Toast.makeWith({ title: `Size changed to ${newSize}` }).show();
              },
            });

            $footer.assignStyles({
              border: "1px solid var(--divider)",
              borderRadius: "8px",
            });

            $section.append($label, $footer);
            $col.appendChild($section);
          }

          return $col;
        },
      },
      {
        title: "Last Page",
        render: () => {
          const $footer = TableFooter.make();
          $footer.bind({
            currentPage: 10,
            pageSize: 25,
            totalItems: 237,
            onPageChange: (page) => {
              Toast.makeWith({ title: `Page changed to ${page}` }).show();
            },
            onPageSizeChange: (pageSize) => {
              Toast.makeWith({ title: `Page size changed to ${pageSize}` }).show();
            },
          });

          return $footer.assignStyles({
            width: "100%",
            maxWidth: "800px",
            border: "1px solid var(--divider)",
            borderRadius: "8px",
          });
        },
      },
    ];
  }
}
