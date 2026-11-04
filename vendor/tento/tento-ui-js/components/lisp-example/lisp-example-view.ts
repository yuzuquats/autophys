import type { ProseMirrorEditor } from "../prosemirror";
import { LispExample } from "./lisp-example";

export class LispExampleView {
  dom: LispExample;

  constructor(node: ProseMirrorEditor.ProseMirrorNode) {
    this.dom = LispExample.make();

    const code = node.attrs.code || "";
    this.dom.setAttribute("code", code);
    this.dom.bind?.({ code, editable: true });
  }

  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "lisp_example") {
      return false;
    }

    const code = node.attrs.code || "";
    if (this.dom.getAttribute("code") !== code) {
      this.dom.setAttribute("code", code);
      this.dom.bind?.({ code, editable: true });
    }

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
