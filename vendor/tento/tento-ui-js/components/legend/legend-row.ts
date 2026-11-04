import "../home-card/row-icon";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LoadingIcon, LonaIcons } from "../../ui/icons";
import { Avatar } from "../avatar";
import { RowIcon } from "../home-card/row-icon";

/**
 * The presentational legend row — one label line in a sheet/calendar legend
 * rail: an icon, a name, an optional hover-reveal badge, an optional sync
 * spinner.
 *
 * It is props-pure: everything it draws arrives through {@link
 * LegendRow.Props}, so it knows nothing about sheets, rows, plugins, or
 * timescales. Callers own every derivation — the label fallback chain, what
 * the badge's initials mean, whether a row is syncing.
 *
 * `selected` stays an attribute rather than a prop: it is set by the rail
 * that owns selection, and the `:host([selected])` hover-plate rule reads it
 * directly.
 */
@component({
  name: "std-legend-row",
})
export class LegendRow extends LonaWebComponent {
  $icon: RowIcon = this.hydrate("icon");
  private $loadingIcon: Option<HTMLElement> = null;
  private $timescaleIndicator: Option<Avatar> = null;
  private badgeKey: Option<string> = null;

  bind(props: LegendRow.Props) {
    this.clearChildren();

    // Self-declaration for the collapsed rail (Sheet's `legend-collapsed`
    // block). This row HAS a condensed projection: the name survives, the
    // icon and the timescale badge fade out, and the label slides into the
    // icon's place — all of it in the CSS below, driven by the
    // `--legend-row-*` tokens the rail publishes. Stated unconditionally
    // because it is a property of the component, not of this row's data;
    // the rail mirrors it onto the frame the kill rule actually selects.
    // Re-set on every bind, which is also what restores it after pooling —
    // `_recycle` strips every attribute.
    this.toggleAttribute("condensed-capable", true);

    this.toggleAttribute("disabled", props.disabled);

    const onPress = props.onPress;

    this.$icon.bind({ icon: props.icon.emoji }, { icon: props.icon.fallback });
    this.$icon.addPointerEvent({
      onClick: () => onPress?.("emoji"),
      onContextMenu: () => onPress?.("emoji"),
    });

    this.$("label").textContent = props.label;
    GESTURE_MANAGER.addPointerEvent(this.$("label-container"), {
      onClick: () => onPress?.("default"),
      onContextMenu: () => onPress?.("default"),
    });

    // Timescale indicator — suppress during rebind to prevent flicker.
    // The badge is hidden immediately and revealed in a fastdom mutate
    // which batches with the sentinel's width application, so the badge
    // only appears after the legend column width is stable.
    const badge = props.badge;
    if (badge) {
      if (!this.$timescaleIndicator) {
        this.$timescaleIndicator = Avatar.make();
        this.$timescaleIndicator.id = "timescale-indicator";
      }
      // A timescale switch rebinds every legend row, but the badge content
      // itself rarely changes — and an unconditional bindInitials rebuilds
      // the avatar's whole subtree (tooltip churn included) per row per pass.
      const badgeKey = `${badge.initials}|${badge.tooltip ?? ""}`;
      if (this.badgeKey !== badgeKey) {
        this.badgeKey = badgeKey;
        this.$timescaleIndicator.bindInitials({
          initials: badge.initials,
          backgroundColor: "var(--bg-surface-light)",
          color: "var(--text-pri)",
          size: "20",
          tooltip: badge.tooltip,
          tooltipPosition: "right",
          shadow: null,
        });
      }
      // Hide immediately so the badge isn't visible during layout flux
      this.$timescaleIndicator.removeAttribute("visible");
      if (this.$timescaleIndicator.parentElement !== this.$("root")) {
        this.$("root").appendChild(this.$timescaleIndicator);
      }
      // Reveal after layout settles (batches with sentinel width apply)
      if (badge.revealed) {
        const $ts = this.$timescaleIndicator;
        $$.mutate(() => $ts.toggleAttribute("visible", true));
      }
    } else if (this.$timescaleIndicator) {
      DomUtils.removeFromDom(this.$timescaleIndicator);
      this.$timescaleIndicator = null;
      this.badgeKey = null;
    }

    if (props.syncing) {
      if (!this.$loadingIcon) {
        this.$loadingIcon = LonaIcons.make(LoadingIcon, { sizePx: 16 });
        this.$loadingIcon.id = "sync-indicator";
      }
      this.$("root").appendChild(this.$loadingIcon);
    } else if (this.$loadingIcon) {
      DomUtils.removeFromDom(this.$loadingIcon);
      this.$loadingIcon = null;
    }
  }

  onRecycle() {
    super.onRecycle();
    // These elements live in shadow $("root"), which survives _recycle().
    // Must remove from DOM before nulling refs, otherwise next bind()
    // creates duplicates (zombie badges).
    this.$timescaleIndicator?.remove();
    this.$timescaleIndicator = null;
    this.$loadingIcon?.remove();
    this.$loadingIcon = null;
  }

  static $labelContainerStyle = css`
    #label {
      color: var(--text-sec);
      --margin-top: 1px;
    }

    #label-container {
      cursor: pointer;
      position: relative;
      height: var(--label-height, 32px);
      flex-grow: 1;
      /* 0 normally — the label is the part that yields when the rail is
         tight. In the condensed projection it is the opposite: the name is
         the only mark this row keeps, so it asks for max-content and
         OVERFLOWS the frame the rail shrank to the lane, exactly as rows
         have always overflowed the collapsed rail. Without this the name
         would reflow into whatever the lane left over (measured: 19px for
         "memory") instead of being clipped at the lane's edge. */
      min-width: var(--legend-row-label-min-width, 0);
      overflow: hidden;
      align-items: center;
      padding-inline: 8px;
      /* 1px normally. In the collapsed rail's condensed projection the
         name is the only mark this row keeps, so it slides into the faded
         icon's place: the rail publishes --legend-row-label-shift (-32px)
         and the label ink lands on the rail's own 8px pad instead of 41px
         in. The fallback IS the expanded value, so an un-collapsed rail —
         and every consumer that never publishes the token, e.g.
         all-day-events/legend.ts reusing this stylesheet — is unchanged. */
      margin-left: var(--legend-row-label-shift, 1px);
    }

    :host([selected]) #label-container::before,
    #label-container:hover::before {
      content: "";
      position: absolute;
      left: 0px;
      top: 2px;
      bottom: 2px;
      right: 0px;
      border-radius: 4px;
      background: var(--bg-hover);
      z-index: 0;
    }

    :host([disabled]) #label-container {
      pointer-events: none;
      display: none;
    }

    #icon {
      min-height: calc(var(--label-height, 32px) - 4px);
      background: var(--std-calendar-legend-background-color);
      /* Condensed projection: the icon is the part the name replaces, so
         it fades. The pointer token is NOT decoration — this icon opens
         the row-options popover on click, and an invisible 24px target
         sitting under the collapsed name would swallow the click that
         belongs to the label. Opacity and hit-testing are separate
         declarations because CSS cannot derive one from the other. Both
         fall back to the expanded value when nothing publishes them. */
      opacity: var(--legend-row-icon-opacity, 1);
      pointer-events: var(--legend-row-icon-pointer, auto);
    }
  `;

  static $styles = [
    LegendRow.$labelContainerStyle,
    css`
      :host {
        position: sticky;
        top: var(--sticky-top);
      }

      #root {
        position: relative;
        align-items: center;
        height: var(--label-height, 32px);
        padding-right: 8px;
      }

      #sync-indicator {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
      }

      #timescale-indicator {
        flex-shrink: 0;
        margin-left: auto;
        padding-left: 1px;
        visibility: hidden;
        /* Condensed projection: the D/W/M/Y badge is a hover-reveal detail
           with no room in a 64px lane. Note it already owns visibility
           (the hover rule below flips it), which is precisely why the
           collapsed state is expressed as opacity + a paired pointer token
           rather than as a visibility token — an inherited
           visibility: hidden would lose to that :host(:hover) rule and the
           badge would pop back over the condensed name. */
        opacity: var(--legend-row-badge-opacity, 1);
        pointer-events: var(--legend-row-badge-pointer, auto);
      }

      :host(:hover) #timescale-indicator,
      #timescale-indicator[visible] {
        visibility: visible;
      }
    `,
  ];

  static $html = html`
    <std-row id="root">
      <std-row-icon id=icon emoji-target></std-row-icon>
      <std-row id="label-container" label-target>
        <p id="label" class="small"></p>
      </std-row>
    </std-row>
  `;
}

export namespace LegendRow {
  export type PressTarget = "default" | "emoji";

  export interface Props {
    /** Already-resolved display text; the caller owns the fallback chain. */
    label: string;
    /** Emoji wins when present; otherwise the fallback template is cloned. */
    icon: { emoji: Option<string>; fallback: HTMLTemplateElement };
    /** System row: hides the label container. */
    disabled: boolean;
    /**
     * `null` keeps the badge out of the DOM entirely. `revealed: false`
     * leaves it hover-only; `revealed: true` pins it visible.
     */
    badge: Option<{ initials: string; tooltip: string; revealed: boolean }>;
    syncing: boolean;
    onPress: Option<(target: PressTarget) => void>;
  }
}
