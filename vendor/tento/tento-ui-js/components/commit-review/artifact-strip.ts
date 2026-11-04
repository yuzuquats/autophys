import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";
import { ArtifactViewer } from "./artifact-viewer";

// Reviewer-facing evidence attached to a commit-set: every artifact renders
// expanded — a caption row (kind + name) over the per-kind viewer (rendering
// + sandboxing shared with std-commit-artifact via [`ArtifactViewer`]).
// Artifacts arrive with their `src` already resolved to a servable URL — the
// component knows nothing about where the bytes live. The strip collapses
// away entirely when empty; the owning page binds only artifacts the note
// doesn't already inline, so the strip is the appendix.

@component({ name: "std-artifact-strip" })
export class ArtifactStrip extends LonaWebComponent {
  private $figures: HTMLElement = this.$("figures");

  bind(artifacts: ArtifactStrip.Artifact[]): void {
    this.$figures.replaceChildren();
    for (const a of artifacts) {
      const $figure = document.createElement("div");
      $figure.className = "artifact-figure";
      $figure.dataset.name = a.name;
      const $caption = document.createElement("div");
      $caption.className = "figure-caption";
      const $kind = Typography.small(a.kind);
      $kind.classList.add("figure-kind");
      const $name = Typography.small(a.name);
      $name.classList.add("figure-name");
      $caption.append($kind, $name);
      $figure.append($caption, ArtifactViewer.$view(a));
      this.$figures.appendChild($figure);
    }
  }

  /** Scroll a bound artifact's figure into view (e.g. from a deep link). */
  open(name: string): void {
    for (const $figure of this.$figures.querySelectorAll<HTMLElement>(".artifact-figure")) {
      if ($figure.dataset.name !== name) continue;
      $figure.scrollIntoView({ behavior: "smooth", block: "start" });
      $figure.classList.remove("jump-flash");
      // Restart the animation when the same figure is targeted twice.
      void $figure.offsetWidth;
      $figure.classList.add("jump-flash");
      return;
    }
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: block;
      }

      #figures:empty {
        display: none;
      }

      #figures {
        display: flex;
        flex-direction: column;
        gap: 14px;
        margin-bottom: 16px;
      }

      .artifact-figure {
        border: 1px solid var(--divider);
        border-radius: 12px;
        overflow: hidden;
        scroll-margin-top: 12px;
      }

      .artifact-figure.jump-flash {
        animation: strip-jump-flash 1.2s ease-out;
      }

      @keyframes strip-jump-flash {
        0%,
        55% {
          border-color: var(--fg-blue, #3b82f6);
        }
        100% {
          border-color: var(--divider);
        }
      }

      .figure-caption {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--divider);
        user-select: none;
      }

      .figure-kind {
        --font-size: var(--text-7px);
        text-transform: uppercase;
        letter-spacing: 0.4px;
        color: var(--text-ter);
      }

      .figure-name {
        color: var(--text-pri);
        font-family: var(--mono, monospace);
      }
    `,
    css(ArtifactViewer.STYLE),
  ];

  static $html: Option<HTMLTemplateElement> = html`<div id="figures"></div>`;
}

// The viewmodel: one attached artifact, pre-resolved by the page (`src` is a
// full servable URL; the wire `entry` never reaches this component).
export namespace ArtifactStrip {
  export type Kind = ArtifactViewer.Kind;
  export type Artifact = ArtifactViewer.Artifact;
}
