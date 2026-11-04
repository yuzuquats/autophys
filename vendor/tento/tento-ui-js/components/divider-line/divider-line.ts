import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";

// A registered separator. The `std-hr` / `std-vr` atoms are CSS rules that a
// caller has to adopt (`Divider.$hr`) and that carry no role; they stay, as the
// charter says, for the thousand places a bare rule is all that is wanted.
// This is the component: `role=separator` with an orientation the reader can
// hear, an optional centred label, and an inset so a list divider can start at
// the text edge rather than the card edge.
@component({ name: "std-divider" })
export class DividerLine extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");

  bind(props: DividerLine.Props): this {
    this.setAttribute("role", "separator");
    this.setAttribute("aria-orientation", props.orientation);
    this.toggleAttribute("vertical", props.orientation === "vertical");
    this.setAttribute("inset", props.inset ?? "none");
    const label = props.label;
    this.$label.textContent = label ?? "";
    this.$label.toggleAttribute("hidden", label == null);
    // A labelled separator is named by its label; an unlabelled one is not
    // named at all, which is what a separator should be.
    if (label != null) this.setAttribute("aria-label", label);
    else this.removeAttribute("aria-label");
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    for (const a of ["role", "aria-orientation", "vertical", "inset", "aria-label"]) {
      this.removeAttribute(a);
    }
    this.$label.textContent = "";
    this.$label.toggleAttribute("hidden", true);
  }

  static makeWith(props: DividerLine.Props): DividerLine {
    return DividerLine.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      /* Every default lives on :host so a caller's value on the host wins. */
      :host {
        --divider-color: var(--divider-color-preset, var(--divider));
        --divider-gap: 8px;
        --divider-margin: 4px;
        --divider-inset: 0px;

        display: flex;
        align-items: center;
        flex-shrink: 0;
        gap: var(--divider-gap);
        width: 100%;
        margin-block: var(--divider-margin);
        padding-inline-start: var(--divider-inset);
      }

      :host([inset="start"]) {
        --divider-inset: 16px;
      }

      :host([inset="both"]) {
        padding-inline: 16px;
      }

      :host([vertical]) {
        flex-direction: column;
        width: auto;
        height: 100%;
        margin-block: 0;
        margin-inline: var(--divider-margin);
        padding-inline-start: 0;
        padding-block-start: var(--divider-inset);
      }

      .rule {
        flex: 1;
        background: var(--divider-color);
        height: 1px;
        min-width: 8px;
      }

      :host([vertical]) .rule {
        width: 1px;
        height: auto;
        min-width: 0;
        min-height: 8px;
      }

      #label {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex: none;
        color: var(--text-ter);
        white-space: nowrap;
      }

      #label[hidden] {
        display: none;
      }

      /* With no label the second rule is redundant; one rule spans. */
      #label[hidden] + .rule {
        display: none;
      }
    `,
  ];

  static $html = html`
    <div class="rule"></div>
    <p id="label" hidden></p>
    <div class="rule"></div>
  `;
}

export namespace DividerLine {
  export type Props = {
    orientation: "horizontal" | "vertical";
    /** Centred between two rules; also the separator's accessible name. */
    label: Option<string>;
    /** Where the rule starts: the container edge, the text edge, or both. */
    inset: Option<"none" | "start" | "both">;
  };
}
