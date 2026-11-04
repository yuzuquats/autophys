import type { ProseMirrorEditor } from "../prosemirror";
import { Code } from "./code";

export class CodeBlockView {
  dom: Code;

  constructor(node: ProseMirrorEditor.ProseMirrorNode) {
    this.dom = Code.make();
    const content = node.textContent;
    this.dom.bind({ content, language: node.attrs.params || "plain" });
  }

  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "code_block") return false;
    const content = node.textContent;
    this.dom.bind({ content, language: node.attrs.params || "plain" });
    return true;
  }

  destroy(): void {
    this.dom = null as any;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}
