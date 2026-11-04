import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { Typography } from "../../ui/typography";
import { PillButton } from "../pill-button";

// The bordered "parsed event" card shown inside the spotlight quick-add row.
// Pure presentational @tento-ui core (string props, DOM out, no I/O) so BOTH the
// app (so.lona spotlight, which feeds parsed/relative strings) and the landing
// asset catalog (mock strings) render the SAME component instead of drifting
// clones. Bound by LonaEventsQuickAddRow in so.lona/calendar.routes/spotlight.ts.
@component({ name: "std-quick-add-card" })
export class QuickAddCard extends LonaWebComponent {
  // Latest suggested category + a per-frame write latch. The app calls
  // `bindCategory` on every keystroke; we coalesce a burst into a single
  // fastdom write (latest value wins) instead of thrashing layout.
  private _pendingCategory: Option<QuickAddCard.Category> = null;
  private _categoryScheduled = false;

  static makeWith(props: QuickAddCard.Props): QuickAddCard {
    return (QuickAddCard.make() as QuickAddCard).bind(props);
  }

  bind(props: QuickAddCard.Props): this {
    this.$("title").textContent = props.title;
    this.$("start").textContent = props.startLabel;
    this.$("end").textContent = props.endLabel;
    return this;
  }

  /**
   * Set (or clear) the suggested-category chip. Safe to call on every
   * keystroke: the DOM write is deferred to the next frame via fastdom and
   * coalesced, so only the most-recent category is rendered per frame
   * (non-blocking — the keystroke handler never touches layout).
   */
  bindCategory(category: Option<QuickAddCard.Category>): void {
    this._pendingCategory = category;
    if (this._categoryScheduled) return;
    this._categoryScheduled = true;
    $$.mutate(() => {
      this._categoryScheduled = false;
      this.renderCategory(this._pendingCategory);
    });
  }

  private renderCategory(category: Option<QuickAddCard.Category>): void {
    const $slot = this.$("category");
    DomUtils.clearChildren($slot);
    if (!category) {
      $slot.style.display = "none";
      return;
    }
    $slot.style.display = "";
    $slot.appendChild(
      PillButton.makeWith(`${category.emoji} ${category.name}`, {
        background: category.color,
        ...PillButton.Options.SMALL,
      }),
    );
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        border-radius: 8px;
        border: 1px solid var(--divider);
        padding: 12px;
      }

      #title {
        --margin-bottom: 8px;
        font-weight: 600;
      }

      #time-label {
        --margin-bottom: 0px;
      }

      #category {
        margin-top: 8px;
        align-items: center;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <p id=title class=h6></p>
      <p id=time-label><span id=start></span> - <span id=end></span></p>
      <std-row id=category style=display:none></std-row>
    </std-col>
  `;
}

export namespace QuickAddCard {
  // A resolved category to chip — the app maps an EventCategoryItem into
  // this @tento-lona-free shape so the card stays a pure @tento-ui leaf.
  export type Category = {
    emoji: string;
    name: string;
    color: string;
  };

  export type Props = {
    title: string;
    startLabel: string;
    endLabel: string;
  };
}
