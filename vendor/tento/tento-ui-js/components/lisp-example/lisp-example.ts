import "../codemirror";
import "@tento-ui/components/icon-button";

import { IconButton } from "@tento-ui/components/icon-button";
import PlayFillIcon from "@tento-ui/icons/bootstrap/play-fill.svg";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Lisp } from "@tento-lisp/lisp";
import { CodeMirrorEditor } from "../codemirror";

@component({
  name: "std-lisp-example",
})
export class LispExample extends LonaWebComponent {
  private static readonly MIN_EDITOR_HEIGHT = 44;

  private $editor: CodeMirrorEditor = this.hydrate("editor");
  private $runButton: IconButton = this.hydrate("run-button");
  private $output = this.$("output");
  private didLayout: boolean = false;
  private revealFallbackTimer: Option<ReturnType<typeof setTimeout>>;

  private revealAfterLayout(): void {
    if (this.didLayout) return;
    const ready =
      this.$editor.offsetWidth > 0 &&
      this.$editor.offsetHeight >= LispExample.MIN_EDITOR_HEIGHT;
    if (!ready) return;

    this.didLayout = true;
    this.style.opacity = "1";
    this.$editor.onSizeChange = null;
    if (this.revealFallbackTimer != null) {
      globalThis.clearTimeout(this.revealFallbackTimer);
      this.revealFallbackTimer = null;
    }
  }

  constructor() {
    super();
    this.$runButton.bindIcon(PlayFillIcon, { squarish: true });
  }

  async bind({ code, editable = true }: LispExample.Props = {}): Promise<this> {
    if (!this.didLayout) {
      this.style.opacity = "0";
      this.$editor.onSizeChange = (size) => {
        if (size.width <= 0 || size.height < LispExample.MIN_EDITOR_HEIGHT) {
          return;
        }
        this.revealAfterLayout();
      };
      this.$editor.initRo();
      this.revealAfterLayout();
      this.revealFallbackTimer = globalThis.setTimeout(
        () => this.revealAfterLayout(),
        150,
      );
    }

    await this.$editor.bind({
      content: code ?? "",
      language: "lisp",
      editable,
      onUpdate: () => {
        this.$output.textContent = "";
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$runButton, {
      onClick: () => this.runCode(),
    });

    this.revealAfterLayout();

    return this;
  }

  private runCode(): void {
    const code = this.$editor.value;
    if (!code) {
      this.$output.textContent = "";
      return;
    }

    const expression = Lisp.parseAll(code);
    const result = Lisp.run(expression, new Lisp.Environment.Default());
    this.$output.textContent = LispExample.display(result);
    this.$output.style.color = "var(--text-sec)";
  }

  static $style = css`
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      opacity: 1;
      transition: opacity 0.2s ease;
      border: 1px solid var(--divider);
      border-radius: 8px;
      overflow: hidden;
      margin: 16px 0;
    }

    #root::before {
      position: absolute;
      content: "";
      left: 0px;
      width: 20px;
    }

    #editor {
      width: 100%;
      min-height: 44px;
      border-bottom: 1px solid var(--divider);
      --bg-codemirror: var(--bg-surface-light-opaque);
      --bg-codemirror-gutter: var(--bg-surface-light-opaque);
    }

    #controls {
      padding: 8px 12px;
      background-color: var(--bg-elevated);
      gap: 12px;
      align-items: center;
    }

    #run-button {
      --std-icon-button-dimension: 24px;
      color: var(--text-sec);
      flex-shrink: 0;
    }

    #run-button:hover {
      color: var(--text-pri);
    }

    #output {
      flex-grow: 1;
      color: var(--text-sec);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  static $styles = [LispExample.$style];
  static $html = html`
    <std-codemirror id="editor"></std-codemirror>
    <std-row id="controls">
      <std-icon-button id="run-button" squarish></std-icon-button>
      <p id="output"></p>
    </std-row>
  `;
}

export namespace LispExample {
  export type Props = Optional<{
    code: string;
    editable: boolean;
  }>;

  export function display(expr: Option<Lisp.Expression>): string {
    const ty = typeof expr;
    switch (ty) {
      case "string":
        return expr as string;
      case "number":
      case "bigint":
      case "boolean":
      case "symbol":
      case "function":
        return String(expr);
      case "undefined":
        return "<null>";
      case "object":
        return JSON.stringify(expr, null, 2);
    }
  }
}
