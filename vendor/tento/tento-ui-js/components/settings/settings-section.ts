import "../round";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Round } from "../round";
import { Shimmer } from "../shimmer";
import { $$ } from "../../fastdom";

// One titled card of a settings page. Extracted from lona.so's
// `lona-settings-section`, which every settings section there wraps: a quiet
// heading above a rounded surface, a shimmer while the section's data loads,
// and `top`/`bottom` halves for a card that is split around a list.
//
// Content arrives in the DEFAULT slot. The heading is text bound through
// `bind`, or a caller's own element in the `title` slot — the fallback content
// of that slot is the bound heading, so the two never render together.
//
// The surface is a `std-round` so the corners keep the squircle every other
// lona card draws. A grouped half (`group="top" | "middle" | "bottom"`) cannot
// use it: the shared edge must be squarer than the outer one, so the halves
// paint the surface on the content box instead, as lona.so's did.
@component({ name: "std-settings-section" })
export class SettingsSection extends LonaWebComponent {
  private $bg: Round = this.hydrate<Round>("bg").bind({
    bg: "var(--settings-card-bg, var(--bg-surface-light))",
    radius: 16,
    shadow: false,
  });

  private surfaceGeneration = 0;

  connectedCallback() {
    super.connectedCallback();
    const generation = ++this.surfaceGeneration;
    // Round queues its initial fill and radius. Paint those immediately, then
    // restore its normal transitions after the first rendered frame.
    this.$bg.style.transition = "none";
    $$.mutateEnd(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.isConnected && generation === this.surfaceGeneration) {
        this.$bg.style.removeProperty("transition");
      }
    })));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // A queued reveal from an earlier attachment must not affect a new one.
    ++this.surfaceGeneration;
  }

  static get observedAttributes() {
    return ["loading", "group"];
  }

  attributeChangedCallback() {
    // The shimmer rides whichever element paints the surface.
    const loading = this.hasAttribute("loading");
    const grouped = this.hasAttribute("group");
    this.$bg.toggleAttribute("loading-shimmer-overlay", loading && !grouped);
    this.$("card").toggleAttribute("loading-shimmer-overlay", loading && grouped);
  }

  static makeWith(props: SettingsSection.Props): SettingsSection {
    return SettingsSection.make().bind(props);
  }

  bind(props: SettingsSection.Props): this {
    if (props.id) this.id = props.id;
    this.$("title").textContent = props.title ?? "";
    this.$("title").hidden = !props.title;
    this.$("caption").textContent = props.caption ?? "";
    this.$("caption").hidden = !props.caption;
    this.setFooter(props.footer);
    this.toggleAttribute("divided", props.divided ?? false);
    if (props.group) this.setAttribute("group", props.group);
    else this.removeAttribute("group");
    this.setLoading(props.loading ?? false);
    return this;
  }

  /** The line under the card alone, for text that tracks a control. */
  setFooter(footer: Option<string>): this {
    this.$("footer").textContent = footer ?? "";
    this.$("footer").hidden = !footer;
    return this;
  }

  setLoading(loading: boolean): this {
    this.toggleAttribute("loading", loading);
    return this;
  }

  /** The heading style, for a caller that slots its own `title` element and
   * wants it to match. */
  static $sectionTitle = css`
    .section-title {
      font-weight: 400;
      color: var(--text-sec);
      --margin-bottom: 12px;
      margin-inline: 12px;
      --font-size: var(--p-size);
    }
  `;

  static $styles = [
    Shimmer.$style,
    SettingsSection.$sectionTitle,
    css`
      :host {
        display: block;
        min-width: 0;
      }

      #heading {
        margin-inline: 8px;
      }

      #caption {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 12px;
        margin-inline: 12px;
        color: var(--text-ter);
      }

      #card {
        position: relative;
        /* Keep the floating surface above the page background. */
        isolation: isolate;
        padding: var(--settings-card-padding, 6px 12px);
      }

      :host([group]) #bg {
        opacity: 0;
      }

      :host([group]) #card {
        border-radius: 6px;
        background: var(--settings-card-bg, var(--bg-surface-light));
      }

      :host([group="top"]) #card {
        border-top-left-radius: 16px;
        border-top-right-radius: 16px;
      }

      :host([group="bottom"]) #card {
        border-bottom-left-radius: 16px;
        border-bottom-right-radius: 16px;
      }

      :host([divided]) ::slotted(:not(:first-child)) {
        border-top: 1px solid var(--divider);
      }

      #footer {
        --font-size: var(--small-size);
        --margin-top: 8px;
        --margin-bottom: 0px;
        margin-inline: 12px;
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <div id="heading">
        <slot name="title"><h2 id="title" class="section-title" hidden></h2></slot>
      </div>
      <p id="caption" hidden></p>
      <div id="card">
        <std-round id="bg" floating></std-round>
        <slot></slot>
      </div>
      <p id="footer" hidden></p>
    </std-col>
  `;
}

export namespace SettingsSection {
  export type Group = "top" | "middle" | "bottom";

  export type Props = {
    /** Element id, for `SettingsBody.section(id)`, tests and deep links. */
    id?: Option<string>;
    title?: Option<string>;
    /** One quiet line under the heading, above the card. */
    caption?: Option<string>;
    /** One quiet line under the card. */
    footer?: Option<string>;
    /** Hairlines between the card's children. */
    divided?: boolean;
    /** Which part of a card split across several sections this one is. */
    group?: Option<Group>;
    /** Shimmer over the card while its data loads. */
    loading?: boolean;
  };
}
