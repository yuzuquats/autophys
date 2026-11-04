import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { ArtifactViewer } from "../commit-review/artifact-viewer";

// An html fragment embedded in a commit note:
//   <std-review-html src="<entry name>" title="…" height="…"></std-review-html>
// `src` names an html entry under the set's `artifacts/` (a relative path,
// resolved by the owning page exactly like std-commit-artifact's). The
// fragment ALWAYS renders in an opaque-origin sandboxed iframe — commit
// content is agent-authored and the review origin holds verdict capability —
// via the same `ArtifactViewer.$sandboxedFrame` policy as every other
// commit-attached document, and ALWAYS as a framed figure with a caption row
// (an unframed iframe reads as a broken note — review feedback). An unknown
// name fails loud, like every teaching surface here.

@component({ name: "std-review-html" })
export class ReviewHtml extends LonaWebComponent {
  private $body: HTMLElement = this.$("body");
  private $caption: HTMLElement = this.$("caption");

  private artifacts: Option<Promise<ArtifactViewer.Artifact[]>> = null;
  private expanded = false;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$caption, {
      onClick: () => {
        if (this.hasAttribute("expandable") && !this.expanded) {
          this.expanded = true;
          this.toggleAttribute("expandable", false);
          this.mount();
        }
      },
    });
  }

  bind({ artifacts }: ReviewHtml.Props): void {
    this.artifacts = artifacts;
    const collapsedAttr = this.getAttribute("collapsed");
    const collapsed =
      collapsedAttr != null && collapsedAttr !== "" && collapsedAttr !== "0" && collapsedAttr !== "false";
    this.expanded = !collapsed;
    this.toggleAttribute("expandable", collapsed);
    if (this.expanded) {
      this.mount();
      return;
    }
    // Collapsed: caption chip only — the sandboxed frame mounts on click.
    this.$body.replaceChildren();
    this.bindCaption(this.getAttribute("src") ?? "");
  }

  onRecycle(): void {
    super.onRecycle();
    this.artifacts = null;
    this.expanded = false;
  }

  private mount(): void {
    const artifacts = this.artifacts;
    if (artifacts == null) return;
    const name = this.getAttribute("src") ?? "";
    this.$body.replaceChildren(this.$skeleton("loading fragment…"));
    this.$caption.replaceChildren();
    void artifacts.then(
      (list) => {
        const artifact = list.find((a) => a.name === name) ?? null;
        if (artifact == null) {
          this.$body.replaceChildren(
            this.$error(
              `unknown fragment "${name}" — attached: ` +
                (list.map((a) => a.name).join(", ") || "(none)"),
            ),
          );
          return;
        }
        const heightAttr = Number(this.getAttribute("height"));
        const $frame = ArtifactViewer.$sandboxedFrame(
          artifact.src,
          Number.isFinite(heightAttr) && heightAttr > 0 ? heightAttr : null,
        );
        this.$body.replaceChildren($frame);
        this.bindCaption(name);
      },
      (e) => {
        this.$body.replaceChildren(this.$error(`failed to load artifacts: ${e}`));
      },
    );
  }

  private bindCaption(name: string): void {
    const title = this.getAttribute("title") ?? "";
    const $kind = Typography.small("html");
    $kind.classList.add("kind");
    const $name = Typography.small(name);
    $name.classList.add("name");
    const children: HTMLElement[] = [$kind, $name];
    if (title !== "") {
      const $title = Typography.small(title);
      $title.classList.add("title", "no-wrap");
      children.push($title);
    }
    if (this.hasAttribute("expandable") && !this.expanded) {
      const $hint = Typography.small("show fragment");
      $hint.classList.add("hint");
      children.push($hint);
    }
    this.$caption.replaceChildren(...children);
  }

  private $skeleton(message: string): HTMLElement {
    const $m = Typography.small(message);
    $m.classList.add("state", "skeleton");
    return $m;
  }

  private $error(message: string): HTMLElement {
    const $m = Typography.small(message);
    $m.classList.add("state", "error");
    return $m;
  }

  static $styles = [
    Typography.$style,
    Typography.$noWrap,
    css`
      :host {
        display: block;
        margin-block: 12px;
        border: 1px solid var(--divider);
        border-radius: 12px;
        overflow: hidden;
      }

      iframe {
        display: block;
        width: 100%;
        height: 440px;
        border: none;
        background: #fff;
      }

      #caption:empty {
        display: none;
      }

      .state {
        padding: 14px 12px;
      }

      .skeleton {
        color: var(--text-ter);
      }

      .error {
        --font-size: var(--small-size);
        color: var(--orange, #e0862a);
        font-family: var(--mono, monospace);
        white-space: pre-wrap;
      }

      #caption {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 8px 12px;
        border-top: 1px solid var(--divider);
        user-select: none;
      }

      #caption .kind {
        --font-size: var(--text-7px);
        text-transform: uppercase;
        letter-spacing: 0.4px;
        color: var(--text-ter);
      }

      #caption .name {
        color: var(--text-pri);
        font-family: var(--mono, monospace);
      }

      #caption .title {
        color: var(--text-ter);
        flex: 1;
        min-width: 0;
      }

      /* Collapsed (expandable) fragment: the caption IS the whole box. */
      :host([expandable]) #caption {
        border-top: none;
        cursor: pointer;
      }
      :host([expandable]) #caption:hover {
        background: var(--bg-hover-light);
      }
      #caption .hint {
        margin-left: auto;
        color: var(--text-ter);
      }
    `,
  ];

  static $html = html`
    <div id="body"></div>
    <div id="caption"></div>
  `;
}

export namespace ReviewHtml {
  export type Props = {
    /** The set's artifacts, viewmodel-shaped, `src` pre-resolved to servable
     * URLs. May still be in flight — skeletons until it settles. */
    artifacts: Promise<ArtifactViewer.Artifact[]>;
  };
}
