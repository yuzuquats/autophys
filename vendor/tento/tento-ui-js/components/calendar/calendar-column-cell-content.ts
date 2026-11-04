import { LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { DateTime, NaiveTime, TimePoint } from "@tento-chrono";
import {
  adoptLightChipStyles,
  LightChipParts,
} from "./calendar-column-cell-content-light";

@component({
  name: "std-calendar-column-cell-content",
})
export class CalendarColumnCellContent extends LonaWebComponent {
  /**
   * The chip's parts: built here and attached on connect
   * (calendar-column-cell-content-light.ts).
   */
  private readonly parts: LightChipParts = LightChipParts.make();
  private $root = this.parts.root;
  private $label = this.parts.label;
  private $hoursLabel = this.parts.hoursLabel;

  /** The component base builds a chip without a shadow root (`LonaWebComponent.lightDom`, read once at construction), as it builds its cell. */
  static lightDom(): boolean {
    return true;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // The chip owns its children: a recycled chip comes back empty (`_recycle`
    // clears them), and text a renderer wrote on the chip itself is not a part.
    if (this.firstElementChild !== this.$root) this.replaceChildren(this.$root);
    adoptLightChipStyles(this.getRootNode());
  }

  static makeWith(
    config: CalendarColumnCellContent.Props,
  ): CalendarColumnCellContent {
    const $cell = CalendarColumnCellContent.make();
    $cell.bind(config);
    return $cell;
  }

  bindNullState() {
    CalendarColumnCellContent.writeText(this.$label, "Untitled");
    CalendarColumnCellContent.writeText(this.$hoursLabel, "");
    this.$hoursLabel.assignStyles({ visibility: "hidden" });
  }

  /**
   * Show `label` alone, with no time line: a renderer's own text (a candidate
   * assignment's task). It goes into the label part, the one place it
   * renders: text written on the chip itself replaces its parts until its
   * next connect.
   */
  bindLabel(label: string): void {
    if (this.$root.hasAttribute("duration")) this.$root.removeAttribute("duration");
    CalendarColumnCellContent.writeText(this.$label, label);
    CalendarColumnCellContent.writeText(this.$hoursLabel, "");
    this.$hoursLabel.assignStyles({ visibility: "hidden" });
  }

  bind({ label, time, timeLabel, use24Hour }: CalendarColumnCellContent.Props) {
    const duration = time.duration;
    const durationMins = duration.toMins;

    const durationAttribute = durationMins <= 15 ? "<=15m" :
      durationMins <= 30 ? "<=30m" : null;
    if (this.$root.getAttribute("duration") !== durationAttribute) {
      if (durationAttribute === null) this.$root.removeAttribute("duration");
      else this.$root.setAttribute("duration", durationAttribute);
    }

    // A rebind (a pooled cell retargeted to another event included) writes the
    // label's text node in place: no node is inserted, so no style recalc.
    CalendarColumnCellContent.writeText(this.$label, label);

    const h24 = use24Hour ?? false;
    const hoursLabel = `${NaiveTime.Formatter.render(
      timeLabel.start.time,
      {
        use24Hour: h24,
        includeSeconds: false,
        padHours: false,
      },
    )} \u2013 ${NaiveTime.Formatter.render(timeLabel.end.time, {
      use24Hour: h24,
      includeSeconds: false,
      padHours: false,
    })}`;
    CalendarColumnCellContent.writeText(this.$hoursLabel, hoursLabel);
    this.$hoursLabel.assignStyles({
      visibility: durationMins <= 15 ? "hidden" : "inherit",
    });
  }

}

export namespace CalendarColumnCellContent {
  /** `Node.TEXT_NODE`, without reading the DOM's `Node` global. */
  const TEXT_NODE = 3;

  /** What `writeText` touches on a label element: `HTMLElement` satisfies it; tests fake it. */
  export interface TextHost {
    readonly firstChild: { readonly nodeType: number; data?: string } | null;
    readonly childNodes: { readonly length: number };
    textContent: string | null;
  }

  /**
   * Show `text` in `$host`. When the host already holds exactly one text
   * node, its `data` is updated in place (a character-data change: layout
   * only); `textContent` would replace the node, and every inserted text node
   * is a style invalidation. Unchanged text writes nothing.
   */
  export function writeText($host: TextHost, text: string): void {
    const $first = $host.firstChild;
    if ($first != null && $first.nodeType === TEXT_NODE && $host.childNodes.length === 1) {
      if ($first.data !== text) $first.data = text;
      return;
    }
    if ($host.textContent !== text) $host.textContent = text;
  }

  export type Props = {
    label: string;
    time: TimePoint.Range;
    timeLabel: DateTime.Range;
    use24Hour?: boolean;
  };
}
