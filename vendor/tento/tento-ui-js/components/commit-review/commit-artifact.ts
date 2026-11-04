import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { ArtifactViewer } from "./artifact-viewer";

// An artifact figure inlined in a commit note. The note markdown embeds
//   <std-commit-artifact src="<entry name>" title="…" height="…"></std-commit-artifact>
// where `src` names a dir entry under the set's `artifacts/` — the same name
// the appendix strip shows — so notes stay location-agnostic and the server's
// kind auto-typing keeps working. The owning page injects the set's resolved
// artifact list at bind(); this component renders a skeleton until it lands,
// then the shared per-kind viewer with a caption row underneath. An unknown
// name fails loud (the note is a teaching surface — a silently blank figure
// defeats it). `collapsed="1"` marks heavyweight evidence: only the caption
// chip renders until the reviewer clicks it — the viewer mounts on expand.

@component({ name: "std-commit-artifact" })
export class CommitArtifact extends LonaWebComponent {
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

  bind({ artifacts }: CommitArtifact.Props): void {
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
    // Collapsed: caption chip only; the kind refines once the list lands.
    this.$body.replaceChildren();
    this.bindCaption(null);
    void artifacts.then(
      (list) => {
        if (this.expanded) return;
        const name = this.getAttribute("src") ?? "";
        this.bindCaption(list.find((a) => a.name === name) ?? null);
      },
      () => {},
    );
  }

  private mount(): void {
    const artifacts = this.artifacts;
    if (artifacts == null) return;
    const name = this.getAttribute("src") ?? "";
    this.$body.replaceChildren(this.$skeleton());
    this.bindCaption(null);
    void artifacts.then(
      (list) => {
        const artifact = list.find((a) => a.name === name) ?? null;
        if (artifact == null) {
          this.$body.replaceChildren(
            this.$error(
              `unknown artifact "${name}" — attached: ` +
                (list.map((a) => a.name).join(", ") || "(none)"),
            ),
          );
          this.bindCaption(null);
          return;
        }
        this.bindCaption(artifact);
        const heightAttr = Number(this.getAttribute("height"));
        this.$body.replaceChildren(
          ArtifactViewer.$view(artifact, {
            height: Number.isFinite(heightAttr) && heightAttr > 0 ? heightAttr : null,
          }),
        );
      },
      (e) => {
        this.$body.replaceChildren(this.$error(`failed to load artifacts: ${e}`));
      },
    );
  }

  onRecycle(): void {
    super.onRecycle();
    this.artifacts = null;
    this.expanded = false;
  }

  private bindCaption(artifact: Option<ArtifactViewer.Artifact>): void {
    const name = this.getAttribute("src") ?? "";
    const title = this.getAttribute("title") ?? "";
    const $kind = Typography.small(artifact?.kind ?? "artifact");
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
      const $hint = Typography.small("show figure");
      $hint.classList.add("hint");
      children.push($hint);
    }
    this.$caption.replaceChildren(...children);
  }

  private $skeleton(): HTMLElement {
    const $s = Typography.small("loading artifact…");
    $s.classList.add("state", "skeleton");
    return $s;
  }

  private $error(message: string): HTMLElement {
    const $e = Typography.small(message);
    $e.classList.add("state", "error");
    return $e;
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

      #body:empty {
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

      /* Collapsed (expandable) figure: the caption IS the whole box — a
         clickable chip; the divider border belongs to the mounted body. */
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
    css(ArtifactViewer.STYLE),
  ];

  static $html = html`
    <div id="body"></div>
    <div id="caption"></div>
  `;
}

export namespace CommitArtifact {
  export type Props = {
    /** The set's artifacts, viewmodel-shaped, `src` pre-resolved. May still
     * be in flight — this component skeletons until it settles. */
    artifacts: Promise<ArtifactViewer.Artifact[]>;
  };
}
