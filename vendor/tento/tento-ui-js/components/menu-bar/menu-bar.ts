import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// The horizontal action row: a strip of controls that act on whatever sits
// next to it. A card's action row under its header, a list's toolbar above the
// list — same object, so the same component.
//
// It exists because `std-card` published a `menubar` slot and every consumer
// then had to invent what goes in it. Market-research put a bare `std-row` in
// the card and hand-rolled a second, differently-metricked flex row for the
// page's sort controls; nothing said the two were the same thing, and they had
// already drifted on gap and alignment.
//
// Content arrives through NAMED SLOTS rather than element adoption. An adopted
// element lands in this shadow root, where the caller's stylesheet cannot
// follow it — the tax `std-section-head` documents, where every adopted child
// degenerates into inline styles. A slotted child stays in the caller's light
// DOM under the caller's own sheet, and this component contributes the
// measure: the split, the gap, the baseline alignment, and the optional rule.
//
// It is a LAYOUT primitive, not a composite widget. It deliberately does not
// claim `role="toolbar"`, because that role promises arrow-key navigation
// between items and this component implements none — the items are ordinary
// focusable controls in DOM order. With a `label` it announces as a group,
// which is a claim it can honour.
@component({ name: "std-menu-bar" })
export class MenuBar extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  static makeWith(props: MenuBar.Props): MenuBar {
    return MenuBar.make().bind(props);
  }

  // Total: every field written on every call, so a pooled instance can never
  // show a previous binding's rule or announce a previous binding's name.
  bind(props: MenuBar.Props): this {
    this.toggleAttribute("rule", props.rule);
    if (props.label == null) {
      this.$root.removeAttribute("role");
      this.$root.removeAttribute("aria-label");
    } else {
      this.$root.setAttribute("role", "group");
      this.$root.setAttribute("aria-label", props.label);
    }
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.removeAttribute("rule");
    this.$root.removeAttribute("role");
    this.$root.removeAttribute("aria-label");
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      /* A slot is display:contents, so the CONTROLS a caller slots become flex
         items of this row directly — which is why align-items and gap below
         reach them and a caller never wraps its controls in a row of its own.
         An earlier cut did wrap them, and then restyled the wrapper through
         ::slotted; that rule lost to std-row's own :host declaration and the
         labels sat top-aligned against their inputs. A component cannot
         reliably restyle a slotted custom element, so this one does not try.

         The spacer between the slots pushes the trailing group to the edge, so
         a bar with only a start group has no trailing gap and a bar with only
         an end group still right-aligns. */
      #root {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: var(--menu-bar-gap, 8px);
        min-height: var(--menu-bar-min-height, 0px);
        padding: var(--menu-bar-padding, 0px);

        /* THE MEASURE INCLUDES THE TYPE SIZE, and this is the one property the
           bar can hand to a slotted control without reaching into it: CSS
           inheritance runs down the FLATTENED tree, so a control assigned to a
           slot inherits from #root, not from wherever it was authored. No
           ::slotted selector, no specificity fight — the rule this component
           already documents about not restyling slotted elements is about
           *overriding* their own declarations, which inheritance never does.

           It matters because nothing else was setting it. std-button
           declares --font-size: var(--p-size) but carries no Typography
           rule to consume it, so a button's label fell through to the
           document's 16px — on a card whose title is 12.5px, the least
           important text on the tile was the largest. Measured before this
           line: the market-research action row was 31px tall for one word.

           --font-size is a CAP HEIGHT (the value is divided by --font-height,
           ~0.72, to get the rendered size), matching every other type
           declaration in this repo. 8.5px of cap is ~11.8px rendered: under
           the card title's 9px cap, over the chip strip's 8px. */
        --font-height: calc(1 - var(--cap-height) - var(--baseline));
        --font-size: var(--menu-bar-cap-size, 8.5px);
        font-size: calc(var(--font-size) / var(--font-height));
      }

      #spacer {
        flex: 1 1 auto;
      }

      /* The rule divides a bar from the content it acts on. It is the host's
         border rather than the row's, so a caller's --menu-bar-padding
         sits inside the line rather than pushing it away from the content. */
      :host([rule]) {
        border-bottom: 1px solid var(--menu-bar-rule-color, var(--divider));
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <slot name="start"></slot>
      <div id="spacer"></div>
      <slot name="end"></slot>
    </std-row>
  `;
}

export namespace MenuBar {
  export interface Props {
    // Announces the bar as a named group. Null for a bar whose purpose is
    // already obvious from the control in it — a lone "Open details" button
    // needs no second name.
    label: Option<string>;
    // Draws a hairline under the bar, for a toolbar that divides itself from
    // the content it acts on.
    rule: boolean;
  }
}
