import type { ProseMirrorEditor } from "../prosemirror";
import { ReviewNav } from "./review-nav";

// NodeView for the `file_ref` inline atom (path-like code spans, retyped by
// the fileRefs markdown option). Renders as an ordinary code span; when the
// page provides navigation and the path uniquely resolves against the diff's
// changed files, it becomes a click-to-scroll chip. Every "Where to look"
// bullet already names paths — this makes the existing corpus navigable
// with zero re-authoring.

export class FileRefView {
  dom: HTMLElement;

  constructor(node: ProseMirrorEditor.ProseMirrorNode, nav: Option<ReviewNav>) {
    this.dom = document.createElement("code");
    this.dom.className = "file-ref";
    this.dom.textContent = node.attrs.path;
    ReviewNav.link(this.dom, node.attrs.path ?? "", nav);
  }

  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "file_ref") return false;
    return node.attrs.path === this.dom.textContent;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}
