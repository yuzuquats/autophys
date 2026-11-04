import { Storybook } from "../../ui/storybook";
import { FileTree } from "./file-tree";

export class FileTreeStoryBook extends Storybook.Default {
  title(): string {
    return "FileTree";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Routes Browser",
        render: () => {
          return FileTree.makeWith({
            nodes: [
              {
                name: "(root)",
                children: [
                  { name: "/", href: "https://lona.so/" },
                  { name: "/signin", href: "https://lona.so/signin" },
                  { name: "/about", href: "https://lona.so/about" },
                ],
              },
              {
                name: "calendar",
                children: [
                  { name: "/", href: "https://calendar.lona.so/" },
                  { name: "/settings", href: "https://calendar.lona.so/settings" },
                ],
              },
              {
                name: "admin",
                children: [
                  {
                    name: "_",
                    children: [
                      {
                        name: "admin",
                        children: [
                          { name: "/", href: "https://admin.lona.so/_/admin" },
                          { name: "/routes", href: "https://admin.lona.so/_/admin/routes" },
                          { name: "/health", href: "https://admin.lona.so/_/admin/health" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
            expandedByDefault: true,
          });
        },
      },
      {
        title: "Nested Folders",
        render: () => {
          return FileTree.makeWith({
            nodes: [
              {
                name: "src",
                children: [
                  {
                    name: "components",
                    children: [
                      { name: "button.ts" },
                      { name: "input.ts" },
                      {
                        name: "forms",
                        children: [
                          { name: "login-form.ts" },
                          { name: "signup-form.ts" },
                        ],
                      },
                    ],
                  },
                  {
                    name: "utils",
                    children: [
                      { name: "format.ts" },
                      { name: "validate.ts" },
                    ],
                  },
                  { name: "index.ts" },
                ],
              },
              {
                name: "tests",
                children: [
                  { name: "app.test.ts" },
                  { name: "utils.test.ts" },
                ],
              },
            ],
            expandedByDefault: true,
          });
        },
      },
      {
        title: "Collapsed by Default",
        render: () => {
          return FileTree.makeWith({
            nodes: [
              {
                name: "src",
                children: [
                  { name: "index.ts" },
                  { name: "app.ts" },
                ],
              },
              {
                name: "tests",
                children: [
                  { name: "app.test.ts" },
                ],
              },
            ],
            expandedByDefault: false,
          });
        },
      },
    ];
  }
}
