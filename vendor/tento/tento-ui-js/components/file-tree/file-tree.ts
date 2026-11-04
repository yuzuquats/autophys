import { LonaWebComponent, html } from "../../component";
import { Column } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";

@component({
  name: "std-file-tree",
})
export class FileTree extends LonaWebComponent {
  private expandedPaths = new Set<string>();
  private nodes: FileTree.Node[] = [];
  private expandByDefault = false;
  private $root: HTMLElement = this.$("root");

  bind(props: FileTree.Props): this {
    this.nodes = props.nodes ?? [];
    this.expandByDefault = props.expandedByDefault ?? false;
    if (this.expandByDefault) {
      this.expandAllPaths(this.nodes, "");
    }
    this.render();
    return this;
  }

  private expandAllPaths(nodes: FileTree.Node[], parentPath: string): void {
    for (const node of nodes) {
      const path = parentPath ? `${parentPath}/${node.name}` : node.name;
      if (node.children) {
        this.expandedPaths.add(path);
        this.expandAllPaths(node.children, path);
      }
    }
  }

  private toggleFolder(path: string): void {
    if (this.expandedPaths.has(path)) {
      this.expandedPaths.delete(path);
    } else {
      this.expandedPaths.add(path);
    }
    this.render();
  }

  private render(): void {
    DomUtils.clearChildren(this.$root);
    const $column = Column.make();
    this.renderNodes(this.nodes, $column, [], "");
    this.$root.appendChild($column);
  }

  private renderNodes(
    nodes: FileTree.Node[],
    $container: HTMLElement,
    ancestorIsLast: boolean[],
    parentPath: string,
  ): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isLast = i === nodes.length - 1;
      const path = parentPath ? `${parentPath}/${node.name}` : node.name;
      const isFolder = !!node.children;
      const isExpanded = this.expandedPaths.has(path);

      const $row = this.createRow(
        node,
        ancestorIsLast,
        isLast,
        isExpanded,
        path,
      );
      $container.appendChild($row);

      if (isFolder && isExpanded && node.children) {
        this.renderNodes(
          node.children,
          $container,
          [...ancestorIsLast, isLast],
          path,
        );
      }
    }
  }

  private createRow(
    node: FileTree.Node,
    ancestorIsLast: boolean[],
    isLast: boolean,
    isExpanded: boolean,
    path: string,
  ): HTMLElement {
    const isFolder = !!node.children;
    const $row = document.createElement("div");
    $row.className = `tree-row ${isFolder ? "folder-row" : "item-row"}`;

    // Indentation lines for ancestors
    for (const isAncestorLast of ancestorIsLast) {
      const $indent = document.createElement("span");
      $indent.className = "tree-prefix";
      $indent.textContent = isAncestorLast ? "   " : "│  ";
      $row.appendChild($indent);
    }

    // Branch prefix for this node
    const $prefix = document.createElement("span");
    $prefix.className = "tree-prefix";
    $prefix.textContent = isLast ? "└─ " : "├─ ";
    $row.appendChild($prefix);

    if (isFolder) {
      // Chevron for folders
      const $chevron = document.createElement("span");
      $chevron.className = "tree-chevron";
      $chevron.textContent = isExpanded ? "▼" : "▶";
      $row.appendChild($chevron);

      // Folder name
      const $name = document.createElement("span");
      $name.className = "tree-name";
      $name.textContent = node.name;
      $row.appendChild($name);

      GESTURE_MANAGER.addPointerEvent($row, {
        onClick: () => this.toggleFolder(path),
      });
    } else {
      // Leaf node
      if (node.href) {
        const $link = document.createElement("a");
        $link.className = "tree-link";
        $link.href = node.href;
        $link.target = "_blank";
        $link.rel = "noopener noreferrer";
        $link.textContent = node.name;
        $row.appendChild($link);
      } else {
        const $name = document.createElement("span");
        $name.className = "tree-item-name";
        $name.textContent = node.name;
        $row.appendChild($name);
      }
    }

    return $row;
  }

  static makeWith(props: FileTree.Props): FileTree {
    const component = FileTree.make();
    component.bind(props);
    return component;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      #root {
        width: 100%;
      }

      .tree-row {
        display: flex;
        align-items: center;
        padding: 3px 0;
        font-family: monospace;
        --font-size: var(--text-8px);
      }

      .tree-prefix {
        color: var(--fg-icon-ter);
        white-space: pre;
      }

      .tree-chevron {
        width: 20px;
        margin-right: 0px;
        color: var(--fg-icon-sec);
        --font-size: var(--text-8px);
      }

      .tree-name {
        color: var(--text-pri);
        font-weight: 500;
      }

      .tree-item-name {
        color: var(--text-sec);
      }

      .folder-row {
        cursor: pointer;
      }

      .folder-row:hover {
        background: var(--bg-hover);
      }

      .item-row:hover {
        background: var(--bg-hover);
      }

      .tree-link {
        color: var(--blue);
        text-decoration: none;
        --font-size: var(--text-8px);
      }

      .tree-link:hover {
        text-decoration: underline;
      }
    `,
  ];

  static $html = html`
    <div id="root"></div>
  `;
}

export namespace FileTree {
  export interface Node {
    name: string;
    children?: Node[];
    href?: string;
  }

  export type Props = {
    nodes: Node[];
    expandedByDefault?: Option<boolean>;
  };
}
