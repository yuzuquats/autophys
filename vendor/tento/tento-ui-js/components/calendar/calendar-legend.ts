import { Ms, NaiveTime, Time, TimeOfDay } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { Div } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { PIXELS_PER_HOUR } from "./calendar-hour";
import { $$ } from "../../fastdom";
import { $qsa } from "../../dom-selectors";
import { LazySync } from "../../lazy";
import { MathUtils } from "@tento-core/math";

@component({
  name: "std-calendar-legend",
})
export class CalendarLegend extends LonaWebComponent {
  private hoursRange: TimeOfDay.Range = TimeOfDay.Range.DAY;
  private binding = false;
  private offsetMs: number = 0;
  use24Hour: boolean = false;
  $cursor = new LazySync<HTMLDivElement>(() => {
    const $e = Div.make();
    $e.classList.add("hour-label");
    $e.classList.add("cursor-label");
    this.$("hours").appendChild($e);
    return $e;
  });

  static get observedAttributes() {
    return ["start-hrs", "end-hrs", "tz-resolved", "tz-offset-ms"];
  }

  private queueRebind() {
    if (this.binding) return;
    if (!this.isConnected) return;
    this.binding = true;
    $$.mutate(() => {
      this.rebind();
      this.binding = false;
    });
  }

  // TODO: need symmetric toString/parse functions for timeunit
  attributeChangedCallback(
    name: string,
    _oldValue: Option<string>,
    newValue: Option<string>,
  ) {
    switch (name) {
      case "start-hrs":
        this.hoursRange = new TimeOfDay.Range(
          newValue
            ? (TimeOfDay.parse(newValue).asOk() ?? this.hoursRange.start)
            : TimeOfDay.ZERO,
          this.hoursRange.end,
          false,
        );
        this.queueRebind();
        break;
      case "end-hrs":
        this.hoursRange = new TimeOfDay.Range(
          this.hoursRange.start,
          newValue
            ? (TimeOfDay.parse(newValue).asOk() ?? this.hoursRange.end)
            : TimeOfDay.END_OF_DAY,
          true,
        );
        this.queueRebind();
        break;
      case "tz-resolved":
        this.queueRebind();
        break;
      case "tz-offset-ms":
        this.offsetMs = newValue ? parseInt(newValue, 10) : 0;
        this.queueRebind();
        break;
    }
  }

  bind(tzLabel: string, window: TimeOfDay.Range = TimeOfDay.Range.DAY) {
    if (
      !this.hasAttribute("start-hrs") ||
      !this.hoursRange.start.equals(window.start)
    ) {
      this.setAttribute("start-hrs", String(window.start));
    }

    if (
      !this.hasAttribute("end-hrs") ||
      !this.hoursRange.end.equals(window.end)
    ) {
      this.setAttribute(
        "end-hrs",
        String(window.end.equals(TimeOfDay.ZERO) ? 24 : window.end),
      );
    }

    if (this.getAttribute("tz-resolved") !== tzLabel) {
      this.setAttribute("tz-resolved", tzLabel);
    }
  }

  bindOffset(
    tzLabel: string,
    offsetMs: number,
    window: TimeOfDay.Range = TimeOfDay.Range.DAY,
  ) {
    this.bind(tzLabel, window);
    const current = this.getAttribute("tz-offset-ms");
    if (current !== String(offsetMs)) {
      this.setAttribute("tz-offset-ms", String(offsetMs));
    }
  }

  rebind() {
    const startHr = this.hoursRange.start.hrs;
    // dev(
    // 	"calendar legend",
    // 	this.hoursRange.end.toString(),
    // 	this.hoursRange.end.equals(TimeOfDay.ZERO),
    // );

    const endHr = this.hoursRange.end.equals(TimeOfDay.ZERO)
      ? 24
      : this.hoursRange.end.hrs;
    const $hours = [...$qsa(".fixed-label", this.$("hours"))];
    const targetCnt = endHr - startHr;
    const toAdd = targetCnt - $hours.length;
    for (let i = 0; i < toAdd; ++i) {
      const $hrText = Div.make();
      $hrText.classList.add("hour-label");
      $hrText.classList.add("fixed-label");
      $$.mutate(() => this.$("hours").appendChild($hrText));
      $hours.push($hrText);
    }
    for (let i = targetCnt; i < $hours.length; ++i) {
      $hours[i].style.display = "none";
    }

    for (let i = startHr; i < endHr; ++i) {
      const $hrText = $hours[i - startHr];
      $hrText.style.display = "";
      const tzLabel = this.getAttribute("tz-resolved");
      if (i === startHr) {
        $hrText.classList.add("sticky");
        $hrText.textContent = tzLabel;
      } else {
        const displayTime =
          this.offsetMs !== 0
            ? TimeOfDay.wrap({
                toMs: (i * Time.MS_PER_HR + this.offsetMs) as Ms,
              })
            : TimeOfDay.wrap({ hrs: i });
        $hrText.textContent = NaiveTime.Formatter.render(displayTime, {
          includeAmPm: !this.use24Hour,
          use24Hour: this.use24Hour,
          includeMins: this.use24Hour,
          includeSeconds: false,
          padHours: this.use24Hour,
        });
      }
    }
  }

  bindCursor(offset: Option<TimeOfDay>) {
    if (!offset) {
      this.$cursor.maybeGet()?.style.setProperty("display", "none");
      return;
    }
    const $cursor = this.$cursor.get();
    const startHr = this.hoursRange.start.hrs;
    const hr = offset.toMs / Time.MS_PER_HR - startHr;

    $cursor.assignStyles({
      display: "",
      transform: `translateY(${MathUtils.roundToDecimals(hr * PIXELS_PER_HOUR) + 2}px)`,
    });

    const displayTime =
      this.offsetMs !== 0
        ? TimeOfDay.wrap({ toMs: (offset.toMs + this.offsetMs) as Ms })
        : offset;
    $cursor.textContent = displayTime.format({
      includeSeconds: false,
      includeAmPm: !this.use24Hour,
      use24Hour: this.use24Hour,
    });
  }

  bindCursorDisplay(shown: boolean) {
    this.$cursor.maybeGet()?.style.setProperty("opacity", shown ? "1" : "0");
  }

  static $styles = [
    css(`
      :host {
        --std-calendar-legend-transition: none;
        min-width: 80px;
      }

      :host([compact]) {
        min-width: 36px;
      }

      :host([secondary]) {
        min-width: 64px;
        margin-left: 12px;
      }

      :host([secondary][compact]) {
        min-width: 36px;
        margin-left: 0px;
      }

      :host([secondary]) #trailing-lines {
        display: none;
      }

      #root {
        height: 100%;
        min-width: inherit;
      }

      #hours {
        height: 100%;
        min-width: inherit;
        align-items: flex-end;
        margin-inline-end: 8px;
      }

      .hour-label {
        height: ${PIXELS_PER_HOUR}px;
        font-size: 0.6125rem;
        transform: translateY(-5px);
      }

      .sticky {
        position: sticky;
        top: calc(var(--additional-sticky-top, 0px) + var(--sticky-top, 0px));
        align-self: stretch;
        text-align: end;
        z-index: 1;
      }

      .sticky::before {
        content: "";
        position: absolute;
        top: 0px;
        right: 0;
        left: 0;
        height: 24px;
        background: var(
          --std-calendar-legend-background-color,
          var(--bg)
        );
        box-shadow: 0px 0px 3px 6px
          var(--std-calendar-legend-background-color, var(--bg));
        z-index: -1;
      }

      #trailing-lines {
        position: relative;
        width: 8px;
      }

      #trailing-lines::before {
        position: absolute;
        top: 0px;
        left: 0px;
        margin-top: 0px;
        content: "";
        width: calc(100% - 0.5px);
        height: 100%;
        z-index: 0;

        background-image: repeating-linear-gradient(
          180deg,
          var(--divider) 0 1px,
          transparent 1px 100%
        );
        background-size: 100% ${PIXELS_PER_HOUR}px;

        box-sizing: border-box;
        transition: var(--std-calendar-legend-transition);
      }

      .cursor-label {
        position: absolute;
        top: 0px;
        right: 0px;
        color: var(--text-pri);
        background: var(
          --std-calendar-legend-background-color,
          var(--bg)
        );
        height: min-content;
        padding-right: 14px;
        margin-right: 1px;
        z-index: 999;
      }

      .cursor-label::before {
        position: absolute;
        content: "";
        right: 4px;
        left: -8px;
        top: -2px;
        bottom: -2px;
        border-radius: 4px;
        background: var(
          --std-calendar-legend-background-color,
          var(--bg)
        );
        box-shadow: 0px 0.5px 2px 4px var(
          --std-calendar-legend-background-color,
          var(--bg)
        );
        z-index: -1;
      }

      .cursor-label::after {
        position: absolute;
        content: "";
        right: -1px;
        top: 50%;
        width: 6px;
        height: 1px;
        background: var(--divider);
      }
    `),
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <std-spacer></std-spacer>
      <std-col id="hours"></std-col>
      <div id="trailing-lines"></div>
    </std-row>
  `;
}
